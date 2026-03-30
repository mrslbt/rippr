// ── rippr Background Service Worker v2.0 ─────────────
// Mirrors youtube-transcript library approach:
// 1. Innertube player API (ANDROID client) → get caption track URLs
// 2. Fetch caption XML from those URLs
// 3. Parse XML into segments
// Uses declarativeNetRequest to set proper User-Agent headers

const INNERTUBE_API_URL =
  "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";

const INNERTUBE_CONTEXT = {
  client: {
    clientName: "ANDROID",
    clientVersion: "20.10.38",
  },
};

const RE_XML_TRANSCRIPT =
  /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;

// ── Message handler ─────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "fetchTranscript") {
    handleFetchTranscript(msg.videoId)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// ── Main handler ────────────────────────────────────
async function handleFetchTranscript(videoId) {
  console.log("[rippr] Fetching transcript for:", videoId);

  // Try InnerTube API first (ANDROID client)
  let captionTracks;
  let metadata;

  try {
    const result = await fetchViaInnerTube(videoId);
    captionTracks = result.captionTracks;
    metadata = result.metadata;
    console.log("[rippr] InnerTube: found", captionTracks.length, "tracks");
  } catch (e) {
    console.log("[rippr] InnerTube failed:", e.message, "— trying HTML scraping");
  }

  // Fallback: scrape watch page HTML
  if (!captionTracks || captionTracks.length === 0) {
    const result = await fetchViaWebPage(videoId);
    captionTracks = result.captionTracks;
    metadata = result.metadata;
    console.log("[rippr] HTML scrape: found", captionTracks.length, "tracks");
  }

  if (!captionTracks || captionTracks.length === 0) {
    throw new Error(
      "No captions found. This video may not have subtitles enabled."
    );
  }

  // Select first track (or specified language)
  const track = captionTracks[0];
  const transcriptUrl = track.baseUrl;

  console.log("[rippr] Fetching caption URL for lang:", track.languageCode);

  // Fetch the caption XML
  // declarativeNetRequest rule #2 sets the User-Agent for timedtext URLs
  const segments = await fetchCaptionXml(transcriptUrl, videoId);

  return {
    title: metadata.title,
    channel: metadata.author,
    language: track.languageCode,
    duration: metadata.duration,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    tracks: captionTracks.map((t) => ({
      lang: t.languageCode,
      name: t.name?.simpleText || t.languageCode,
      isAuto: t.kind === "asr",
    })),
    segments,
  };
}

// ── Method 1: InnerTube player API (ANDROID client) ──
async function fetchViaInnerTube(videoId) {
  // declarativeNetRequest rule #1 sets Android User-Agent for this URL
  const resp = await fetch(INNERTUBE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      context: INNERTUBE_CONTEXT,
      videoId: videoId,
    }),
  });

  if (!resp.ok) {
    throw new Error(`InnerTube API returned ${resp.status}`);
  }

  const data = await resp.json();

  const captionTracks =
    data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

  if (!Array.isArray(captionTracks) || captionTracks.length === 0) {
    throw new Error("No caption tracks in InnerTube response");
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
}

// ── Method 2: HTML scraping fallback ────────────────
async function fetchViaWebPage(videoId) {
  const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;

  const resp = await fetch(pageUrl, {
    headers: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!resp.ok) throw new Error(`Page fetch returned ${resp.status}`);

  const html = await resp.text();

  if (html.includes('class="g-recaptcha"')) {
    throw new Error("YouTube is requiring CAPTCHA. Try again later.");
  }

  // Extract ytInitialPlayerResponse using brace-counting (robust)
  const marker = "var ytInitialPlayerResponse = ";
  let idx = html.indexOf(marker);
  if (idx === -1) {
    // Try without "var " prefix
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
  const captionTracks =
    player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

  return {
    captionTracks,
    metadata: {
      title: vd.title || "Unknown",
      author: vd.author || "Unknown",
      duration: parseInt(vd.lengthSeconds || "0", 10),
    },
  };
}

// ── Fetch and parse caption XML (with retry) ────────
async function fetchCaptionXml(transcriptUrl, videoId) {
  // Validate URL
  try {
    const u = new URL(transcriptUrl);
    if (
      !u.hostname.endsWith(".youtube.com") &&
      !u.hostname.endsWith(".googleapis.com")
    ) {
      throw new Error("Invalid caption URL hostname");
    }
  } catch (e) {
    throw new Error("Invalid caption URL: " + e.message);
  }

  const MAX_RETRIES = 3;
  let lastError;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(transcriptUrl, {
        headers: {
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      // Don't retry client errors (4xx)
      if (resp.status >= 400 && resp.status < 500) {
        throw new Error(`Caption fetch returned ${resp.status}`);
      }

      if (!resp.ok) {
        throw new Error(`Caption fetch returned ${resp.status}`);
      }

      const xml = await resp.text();

      if (!xml || xml.length < 10) {
        throw new Error("Empty caption response from YouTube");
      }

      console.log("[rippr] Caption XML length:", xml.length);
      return parseTranscriptXml(xml);
    } catch (e) {
      lastError = e;

      // Don't retry client errors (4xx)
      if (/returned 4\d{2}$/.test(e.message)) throw e;

      if (attempt < MAX_RETRIES - 1) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        console.log(`[rippr] Retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError;
}

// ── Parse transcript XML ────────────────────────────
// Supports both srv3 format (<p t="ms" d="ms">) and classic (<text start="s" dur="s">)
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
    if (!text) {
      text = inner.replace(/<[^>]+>/g, "");
    }

    text = decodeEntities(text).trim();
    if (text) {
      results.push({
        start: startMs / 1000,
        duration: durMs / 1000,
        text,
      });
    }
  }

  if (results.length > 0) return results;

  // Fall back to classic format: <text start="s" dur="s">content</text>
  const classicResults = [...xml.matchAll(RE_XML_TRANSCRIPT)];

  if (classicResults.length > 0) {
    return classicResults.map((r) => ({
      text: decodeEntities(r[3]),
      duration: parseFloat(r[2]),
      start: parseFloat(r[1]),
    }));
  }

  // Last resort: try any <text> tags
  const anyTextRegex = /<text[^>]*>([^<]+)<\/text>/g;
  const anyResults = [];
  let m;
  while ((m = anyTextRegex.exec(xml)) !== null) {
    anyResults.push({
      text: decodeEntities(m[1]),
      start: 0,
      duration: 0,
    });
  }

  if (anyResults.length > 0) return anyResults;

  console.log("[rippr] XML sample:", xml.substring(0, 300));
  throw new Error("Could not parse caption XML");
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
