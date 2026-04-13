// rippr Transcript Extraction
// Ported from Cloudflare Worker for MCP server use.
const INNERTUBE_API_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const INNERTUBE_CONTEXT = {
    client: {
        clientName: "ANDROID",
        clientVersion: "20.10.38",
    },
};
const RE_XML_TRANSCRIPT = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;
// ── Video ID extraction ─────────────────────────────
export function extractVideoId(url) {
    if (!url)
        return null;
    url = url.trim();
    let match = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
    if (match)
        return match[1];
    match = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    if (match)
        return match[1];
    match = url.match(/\/(?:embed|v|shorts)\/([a-zA-Z0-9_-]{11})/);
    if (match)
        return match[1];
    match = url.match(/^([a-zA-Z0-9_-]{11})$/);
    if (match)
        return match[1];
    return null;
}
// ── Main: fetch transcript for a video ──────────────
export async function fetchTranscript(videoId) {
    let captionTracks;
    let metadata;
    // Try InnerTube API first
    try {
        const result = await fetchViaInnerTube(videoId);
        captionTracks = result.captionTracks;
        metadata = result.metadata;
    }
    catch {
        // silent — fall through to HTML scraping
    }
    // Fallback: scrape watch page HTML
    if (!captionTracks || captionTracks.length === 0) {
        const result = await fetchViaWebPage(videoId);
        captionTracks = result.captionTracks;
        metadata = result.metadata;
    }
    if (!captionTracks || captionTracks.length === 0) {
        throw new Error("No captions found. This video may not have subtitles enabled.");
    }
    const track = captionTracks[0];
    const segments = await fetchCaptionXml(track.baseUrl);
    return {
        title: metadata.title,
        channel: metadata.author,
        language: track.languageCode,
        isAuto: track.kind === "asr",
        segments,
    };
}
// ── InnerTube player API (ANDROID client) ───────────
async function fetchViaInnerTube(videoId) {
    const resp = await fetch(INNERTUBE_API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "User-Agent": "com.google.android.youtube/20.10.38",
        },
        body: JSON.stringify({
            context: INNERTUBE_CONTEXT,
            videoId,
        }),
    });
    if (!resp.ok)
        throw new Error(`InnerTube API returned ${resp.status}`);
    const data = await resp.json();
    const captionTracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
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
// ── HTML scraping fallback ──────────────────────────
async function fetchViaWebPage(videoId) {
    const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const resp = await fetch(pageUrl, {
        headers: { "Accept-Language": "en-US,en;q=0.9" },
    });
    if (!resp.ok)
        throw new Error(`Page fetch returned ${resp.status}`);
    const html = await resp.text();
    if (html.includes('class="g-recaptcha"')) {
        throw new Error("YouTube is requiring CAPTCHA. Try again later.");
    }
    const marker = "var ytInitialPlayerResponse = ";
    let idx = html.indexOf(marker);
    if (idx === -1) {
        const marker2 = "ytInitialPlayerResponse = ";
        idx = html.indexOf(marker2);
        if (idx === -1)
            throw new Error("Could not find player response in HTML");
        idx += marker2.length;
    }
    else {
        idx += marker.length;
    }
    let depth = 0;
    let jsonEnd = idx;
    for (let i = idx; i < html.length; i++) {
        if (html[i] === "{")
            depth++;
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
    const captionTracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
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
async function fetchCaptionXml(transcriptUrl) {
    const MAX_RETRIES = 3;
    let lastError;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const resp = await fetch(transcriptUrl, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Accept-Language": "en-US,en;q=0.9",
                },
            });
            if (resp.status >= 400 && resp.status < 500) {
                throw new Error(`Caption fetch returned ${resp.status}`);
            }
            if (!resp.ok)
                throw new Error(`Caption fetch returned ${resp.status}`);
            const xml = await resp.text();
            if (!xml || xml.length < 10) {
                throw new Error("Empty caption response from YouTube");
            }
            return parseTranscriptXml(xml);
        }
        catch (e) {
            lastError = e;
            if (/returned 4\d{2}$/.test(e.message))
                throw e;
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
    // Try srv3 format first
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
        if (!text)
            text = inner.replace(/<[^>]+>/g, "");
        text = decodeEntities(text).trim();
        if (text) {
            results.push({ start: startMs / 1000, duration: durMs / 1000, text });
        }
    }
    if (results.length > 0)
        return results;
    // Classic format
    const classicResults = [...xml.matchAll(RE_XML_TRANSCRIPT)];
    if (classicResults.length > 0) {
        return classicResults.map((r) => ({
            text: decodeEntities(r[3]),
            duration: parseFloat(r[2]),
            start: parseFloat(r[1]),
        }));
    }
    // Last resort
    const anyTextRegex = /<text[^>]*>([^<]+)<\/text>/g;
    const anyResults = [];
    let m;
    while ((m = anyTextRegex.exec(xml)) !== null) {
        anyResults.push({ text: decodeEntities(m[1]), start: 0, duration: 0 });
    }
    if (anyResults.length > 0)
        return anyResults;
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
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}
