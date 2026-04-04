import { extractVideoId, fetchTranscript } from "./transcript.js";
import HTML from "./index.html";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
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
