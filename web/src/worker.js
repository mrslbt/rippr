import { extractVideoId, fetchTranscript } from "./transcript.js";
import HTML from "./index.html";
import ICON from "./icon.png";
import OG from "./og.png";
import LLMS from "./llms.txt";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    // Serve robots.txt
    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nAllow: /\nSitemap: https://rippr.me/sitemap.xml\n", {
        headers: { "Content-Type": "text/plain" },
      });
    }

    // Serve sitemap
    if (url.pathname === "/sitemap.xml") {
      return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://rippr.me/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n  <url><loc>https://rippr.me/llms.txt</loc><changefreq>monthly</changefreq><priority>0.5</priority></url>\n</urlset>`, {
        headers: { "Content-Type": "application/xml" },
      });
    }

    // Serve llms.txt
    if (url.pathname === "/llms.txt") {
      return new Response(LLMS, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" },
      });
    }

    // Serve icon
    if (url.pathname === "/icon.png") {
      return new Response(ICON, {
        headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
      });
    }

    // Serve OG image
    if (url.pathname === "/og.png") {
      return new Response(OG, {
        headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
      });
    }

    // Serve frontend
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(HTML, {
        headers: { "Content-Type": "text/html;charset=utf-8" },
      });
    }

    // API: summarize
    if (url.pathname === "/api/summarize" && request.method === "POST") {
      return handleSummarize(request, env);
    }

    // API: rip transcript
    if (url.pathname === "/api/rip" && request.method === "POST") {
      return handleRip(request);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleSummarize(request, env) {
  try {
    const { url } = await request.json();
    if (!url) {
      return jsonResponse({ error: "Missing url" }, 400);
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      return jsonResponse({ error: "Invalid YouTube URL" }, 400);
    }

    // Fetch transcript
    const transcript = await fetchTranscript(videoId);
    const fullText = transcript.segments.map((s) => s.text).join(" ");

    // Truncate aggressively to avoid Workers AI timeout (~6k chars max)
    const truncatedText = fullText.substring(0, 6000);

    // Call Workers AI for summary
    const prompt = `Summarize this YouTube transcript concisely.

Format EXACTLY:

## Summary
[2-3 sentences]

## Key Points
- [point 1]
- [point 2]
- [point 3]
- [point 4]
- [point 5]

## Takeaways
- [takeaway 1]
- [takeaway 2]

Video: "${transcript.title}" by ${transcript.channel}

Transcript:
${truncatedText}`;

    const aiResponse = await env.AI.run("@cf/meta/llama-3.2-3b-instruct", {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 512,
    });

    return jsonResponse({
      title: transcript.title,
      channel: transcript.channel,
      language: transcript.language,
      isAuto: transcript.isAuto,
      content: aiResponse.response,
      videoId,
    });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

async function handleRip(request) {
  try {
    const { url, format, timestamps } = await request.json();
    if (!url) return jsonResponse({ error: "Missing url" }, 400);

    const videoId = extractVideoId(url);
    if (!videoId) return jsonResponse({ error: "Invalid YouTube URL" }, 400);

    const transcript = await fetchTranscript(videoId);

    return jsonResponse({
      title: transcript.title,
      channel: transcript.channel,
      language: transcript.language,
      isAuto: transcript.isAuto,
      videoId,
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      segments: transcript.segments,
    });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
