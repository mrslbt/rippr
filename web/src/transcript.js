// ── rippr Transcript Extraction (Cloudflare Worker) ──
// Ported from Chrome extension background.js for server-side use.

// InnerTube clients — YouTube requires LOGIN/auth from datacenter IPs for most,
// but we still try as a first pass (works when not rate-limited).
const INNERTUBE_CLIENTS = [
  {
    name: "WEB",
    apiUrl: "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
    context: {
      client: {
        clientName: "WEB",
        clientVersion: "2.20250401.01.00",
        hl: "en",
        gl: "US",
      },
    },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  },
  {
    name: "MWEB",
    apiUrl: "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
    context: {
      client: {
        clientName: "MWEB",
        clientVersion: "2.20250401.01.00",
        hl: "en",
        gl: "US",
      },
    },
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  },
];

// Invidious instances — community proxies with different IPs (last resort fallback)
const INVIDIOUS_INSTANCES = [
  "https://inv.nadeko.net",
  "https://invidious.nerdvpn.de",
  "https://iv.datura.network",
];

const RE_XML_TRANSCRIPT =
  /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;

// ── Video ID extraction ─────────────────────────────
export function extractVideoId(url) {
  if (!url) return null;
  url = url.trim();

  let match = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (match) return match[1];

  match = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (match) return match[1];

  match = url.match(/\/(?:embed|v|shorts)\/([a-zA-Z0-9_-]{11})/);
  if (match) return match[1];

  match = url.match(/^([a-zA-Z0-9_-]{11})$/);
  if (match) return match[1];

  return null;
}

// ── Main: fetch transcript for a video ──────────────
// Strategy chain: InnerTube (4 clients) → HTML scrape → Invidious proxy
export async function fetchTranscript(videoId) {
  let captionTracks;
  let metadata;
  let lastError;
  let got429 = false;

  // Strategy 1: HTML scrape (most reliable — tries www + mobile YouTube)
  try {
    const result = await fetchViaWebPage(videoId);
    captionTracks = result.captionTracks;
    metadata = result.metadata;
    console.log(`[rippr] HTML scrape OK for ${videoId}: ${captionTracks?.length} tracks`);
  } catch (e) {
    lastError = e;
    if (e.message.includes("429")) got429 = true;
    console.log(`[rippr] HTML scrape FAIL for ${videoId}: ${e.message}`);
  }

  // Strategy 2: InnerTube API (backup — often LOGIN_REQUIRED from datacenter IPs)
  if (!captionTracks || captionTracks.length === 0) {
    try {
      const result = await fetchViaInnerTube(videoId);
      captionTracks = result.captionTracks;
      metadata = result.metadata;
      console.log(`[rippr] InnerTube OK for ${videoId}: ${captionTracks?.length} tracks`);
    } catch (e) {
      lastError = e;
      if (e.message.includes("429") || e.message.includes("LOGIN_REQUIRED")) got429 = true;
      console.log(`[rippr] InnerTube FAIL for ${videoId}: ${e.message}`);
    }
  }

  // Strategy 3: Invidious proxy (completely different IPs — last resort)
  if (!captionTracks || captionTracks.length === 0) {
    try {
      const result = await fetchViaInvidious(videoId);
      if (result.segments && result.segments.length > 0) {
        console.log(`[rippr] Invidious OK for ${videoId}: ${result.segments.length} segments`);
        return result;
      }
    } catch (e) {
      lastError = e;
      console.log(`[rippr] Invidious FAIL for ${videoId}: ${e.message}`);
    }
  }

  if (!captionTracks || captionTracks.length === 0) {
    // LOGIN_REQUIRED from datacenter IPs is effectively rate-limiting
    const isBlocked = got429 ||
      (lastError && (lastError.message.includes("429") || lastError.message.includes("LOGIN_REQUIRED")));
    if (isBlocked) {
      throw new Error("YouTube returned 429 — rate-limited");
    }
    throw new Error(
      "No captions found. This video may not have subtitles enabled."
    );
  }

  const track = captionTracks[0];
  // Caption URLs from HTML scrape may be relative (/api/timedtext?...)
  let captionUrl = track.baseUrl;
  if (captionUrl.startsWith("/")) {
    captionUrl = "https://www.youtube.com" + captionUrl;
  }
  const segments = await fetchCaptionXml(captionUrl);

  return {
    title: metadata.title,
    channel: metadata.author,
    language: track.languageCode,
    isAuto: track.kind === "asr",
    segments,
  };
}

// ── InnerTube player API (tries TV_EMBED → WEB → IOS) ──
async function fetchViaInnerTube(videoId) {
  let lastError;
  let loginRequired = false;

  for (const client of INNERTUBE_CLIENTS) {
    try {
      const resp = await fetch(client.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": client.userAgent,
        },
        body: JSON.stringify({
          context: client.context,
          videoId,
        }),
      });

      if (!resp.ok) {
        console.log(`[rippr] InnerTube ${client.name} → ${resp.status}`);
        if (resp.status === 429) {
          lastError = new Error(`InnerTube ${client.name} returned 429`);
        } else {
          lastError = new Error(`InnerTube API returned ${resp.status}`);
        }
        continue;
      }

      const data = await resp.json();
      const playability = data?.playabilityStatus?.status;
      const reason = data?.playabilityStatus?.reason || "";
      const captionTracks =
        data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

      console.log(`[rippr] InnerTube ${client.name} → playability=${playability}, tracks=${captionTracks?.length || 0}`);

      // LOGIN_REQUIRED = YouTube blocking datacenter IPs — try next client
      if (playability === "LOGIN_REQUIRED") {
        loginRequired = true;
        lastError = new Error(`InnerTube ${client.name}: LOGIN_REQUIRED`);
        continue;
      }

      if (!Array.isArray(captionTracks) || captionTracks.length === 0) {
        lastError = new Error(`No caption tracks in InnerTube response (playability=${playability})`);
        continue;
      }

      const vd = data.videoDetails || {};
      return {
        captionTracks,
        metadata: {
          title: vd.title || "Unknown",
          author: vd.author || "Unknown",
          duration: parseInt(vd.lengthSeconds || "0", 10),
        },
      };
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError;
}

// ── HTML scraping fallback ──────────────────────────
// Tries www.youtube.com first, then m.youtube.com (mobile has different rate limits)
const PAGE_TARGETS = [
  {
    url: (vid) => `https://www.youtube.com/watch?v=${vid}`,
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  },
  {
    url: (vid) => `https://m.youtube.com/watch?v=${vid}`,
    ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  },
];

async function fetchViaWebPage(videoId) {
  let lastPageError;
  let bestResult = null;

  // Try each domain — YouTube may serve 200 but strip captions from datacenter IPs.
  // If a domain returns 200 with tracks, use it. Otherwise try next domain.
  for (const target of PAGE_TARGETS) {
    const pageUrl = target.url(videoId);
    const MAX_PAGE_RETRIES = 2;
    let resp;

    for (let attempt = 0; attempt < MAX_PAGE_RETRIES; attempt++) {
      try {
        resp = await fetch(pageUrl, {
          headers: {
            "User-Agent": target.ua,
            "Accept-Language": "en-US,en;q=0.9",
            "Cookie": "CONSENT=YES+cb.20210328-17-p0.en+FX+634",
          },
        });

        if (resp.status === 429 && attempt < MAX_PAGE_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1500));
          continue;
        }
        break;
      } catch (e) {
        lastPageError = e;
        resp = null;
      }
    }

    if (!resp?.ok) {
      console.log(`[rippr] HTML scrape: ${pageUrl} → ${resp?.status || 'error'}`);
      lastPageError = new Error(`Page fetch returned ${resp?.status || 'error'}`);
      continue;
    }

    try {
      const result = parseWatchPageHtml(await resp.text());
      console.log(`[rippr] HTML scrape: ${pageUrl} → 200, tracks=${result.captionTracks.length}, playability=${result.playability}`);

      // If we got tracks, use this result immediately
      if (result.captionTracks.length > 0) return result;

      // Save first valid result as fallback (even with 0 tracks)
      if (!bestResult) bestResult = result;

      // If LOGIN_REQUIRED or no tracks, try next domain
      if (result.playability === "LOGIN_REQUIRED" || result.playability === "ERROR") {
        lastPageError = new Error(`HTML page returned playability=${result.playability}`);
        continue;
      }
    } catch (e) {
      console.log(`[rippr] HTML parse error: ${e.message}`);
      lastPageError = e;
    }
  }

  // Return best result even if it has 0 tracks (let caller handle)
  if (bestResult) return bestResult;
  throw lastPageError || new Error("All page fetches failed");
}

// ── Parse watch page HTML for player data ──────────
function parseWatchPageHtml(html) {
  if (html.includes('class="g-recaptcha"')) {
    throw new Error("YouTube is requiring CAPTCHA. Try again later.");
  }

  const marker = "var ytInitialPlayerResponse = ";
  let idx = html.indexOf(marker);
  if (idx === -1) {
    const marker2 = "ytInitialPlayerResponse = ";
    idx = html.indexOf(marker2);
    if (idx === -1) throw new Error("Could not find player response in HTML");
    idx += marker2.length;
  } else {
    idx += marker.length;
  }

  let depth = 0;
  let jsonEnd = idx;
  for (let i = idx; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") {
      depth--;
      if (depth === 0) {
        jsonEnd = i + 1;
        break;
      }
    }
  }

  const player = JSON.parse(html.substring(idx, jsonEnd));
  const vd = player.videoDetails || {};
  const playability = player?.playabilityStatus?.status || "UNKNOWN";
  const captionTracks =
    player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

  return {
    captionTracks,
    playability,
    metadata: {
      title: vd.title || "Unknown",
      author: vd.author || "Unknown",
      duration: parseInt(vd.lengthSeconds || "0", 10),
    },
  };
}

// ── Fetch and parse caption XML (with retry) ────────
async function fetchCaptionXml(transcriptUrl) {
  const MAX_RETRIES = 3;
  let lastError;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(transcriptUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      console.log(`[rippr] Caption fetch → ${resp.status}, url=${transcriptUrl.substring(0, 80)}...`);

      if (resp.status === 429) {
        throw new Error(`Caption fetch returned 429 (retryable)`);
      }
      if (resp.status >= 400 && resp.status < 500) {
        throw new Error(`Caption fetch returned ${resp.status}`);
      }
      if (!resp.ok) throw new Error(`Caption fetch returned ${resp.status}`);

      const xml = await resp.text();
      console.log(`[rippr] Caption XML length: ${xml?.length || 0}`);
      if (!xml || xml.length < 10) {
        throw new Error("Empty caption response from YouTube (429-equivalent)");
      }

      return parseTranscriptXml(xml);
    } catch (e) {
      lastError = e;
      // Fail immediately on 4xx except 429 (which is retryable)
      if (/returned 4\d{2}$/.test(e.message) && !e.message.includes("429")) throw e;
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      }
    }
  }

  throw lastError;
}

// ── Parse transcript XML ────────────────────────────
function parseTranscriptXml(xml) {
  const results = [];

  // Try srv3 format first: <p t="ms" d="ms"><s>word</s>...</p>
  const pRegex = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  let match;
  while ((match = pRegex.exec(xml)) !== null) {
    const startMs = parseInt(match[1], 10);
    const durMs = parseInt(match[2], 10);
    const inner = match[3];

    let text = "";
    const sRegex = /<s[^>]*>([^<]*)<\/s>/g;
    let sMatch;
    while ((sMatch = sRegex.exec(inner)) !== null) {
      text += sMatch[1];
    }
    if (!text) text = inner.replace(/<[^>]+>/g, "");

    text = decodeEntities(text).trim();
    if (text) {
      results.push({ start: startMs / 1000, duration: durMs / 1000, text });
    }
  }

  if (results.length > 0) return results;

  // Classic format: <text start="s" dur="s">content</text>
  const classicResults = [...xml.matchAll(RE_XML_TRANSCRIPT)];
  if (classicResults.length > 0) {
    return classicResults.map((r) => ({
      text: decodeEntities(r[3]),
      duration: parseFloat(r[2]),
      start: parseFloat(r[1]),
    }));
  }

  // Last resort: any <text> tags
  const anyTextRegex = /<text[^>]*>([^<]+)<\/text>/g;
  const anyResults = [];
  let m;
  while ((m = anyTextRegex.exec(xml)) !== null) {
    anyResults.push({ text: decodeEntities(m[1]), start: 0, duration: 0 });
  }

  if (anyResults.length > 0) return anyResults;
  throw new Error("Could not parse caption XML");
}

// ── Invidious proxy fallback (different server IPs) ─
async function fetchViaInvidious(videoId) {
  let lastError;

  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      // Step 1: get caption list
      const listResp = await fetch(`${instance}/api/v1/captions/${videoId}`, {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!listResp.ok) {
        lastError = new Error(`Invidious ${instance} returned ${listResp.status}`);
        continue;
      }

      const data = await listResp.json();
      const captions = data?.captions;
      if (!Array.isArray(captions) || captions.length === 0) {
        lastError = new Error("No captions from Invidious");
        continue;
      }

      // Prefer non-auto English, then any English, then first available
      const track =
        captions.find((c) => c.languageCode === "en" && !c.label.includes("auto")) ||
        captions.find((c) => c.languageCode === "en") ||
        captions[0];

      // Step 2: fetch the actual captions (VTT format)
      const captionUrl = `${instance}${track.url}`;
      const captionResp = await fetch(captionUrl, {
        signal: AbortSignal.timeout(8000),
      });
      if (!captionResp.ok || captionResp.headers.get("content-length") === "0") {
        lastError = new Error("Empty caption response from Invidious");
        continue;
      }

      const vtt = await captionResp.text();
      if (!vtt || vtt.length < 20) {
        lastError = new Error("Empty VTT from Invidious");
        continue;
      }

      const segments = parseVtt(vtt);
      if (segments.length === 0) {
        lastError = new Error("Could not parse Invidious VTT");
        continue;
      }

      // Get video metadata (title/channel)
      let title = "Unknown", channel = "Unknown";
      try {
        const metaResp = await fetch(`${instance}/api/v1/videos/${videoId}?fields=title,author`, {
          headers: { "Accept": "application/json" },
          signal: AbortSignal.timeout(5000),
        });
        if (metaResp.ok) {
          const meta = await metaResp.json();
          title = meta.title || title;
          channel = meta.author || channel;
        }
      } catch { /* metadata is optional */ }

      return {
        title,
        channel,
        language: track.languageCode,
        isAuto: track.label?.includes("auto") || false,
        segments,
      };
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError || new Error("All Invidious instances failed");
}

// ── Parse WebVTT format ────────────────────────────
function parseVtt(vtt) {
  const segments = [];
  const lines = vtt.split("\n");
  let i = 0;

  while (i < lines.length) {
    // Find timestamp line: "00:00:01.360 --> 00:00:03.040"
    const tsMatch = lines[i]?.match(
      /(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})/
    );
    if (tsMatch) {
      const start =
        parseInt(tsMatch[1]) * 3600 +
        parseInt(tsMatch[2]) * 60 +
        parseInt(tsMatch[3]) +
        parseInt(tsMatch[4]) / 1000;
      const end =
        parseInt(tsMatch[5]) * 3600 +
        parseInt(tsMatch[6]) * 60 +
        parseInt(tsMatch[7]) +
        parseInt(tsMatch[8]) / 1000;
      const duration = end - start;

      // Collect text lines until blank line
      i++;
      let text = "";
      while (i < lines.length && lines[i].trim() !== "") {
        const line = lines[i].replace(/<[^>]+>/g, "").trim(); // strip VTT tags
        if (line) text += (text ? " " : "") + line;
        i++;
      }

      if (text) {
        segments.push({ start: Math.round(start * 100) / 100, duration: Math.round(duration * 100) / 100, text });
      }
    }
    i++;
  }

  return segments;
}

// ── Decode HTML entities ────────────────────────────
function decodeEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec) =>
      String.fromCodePoint(parseInt(dec, 10))
    );
}
