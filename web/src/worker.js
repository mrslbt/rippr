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

    // Truncate to ~12k tokens (~48k chars) to stay within model context
    const truncatedText = fullText.substring(0, 48000);

    // Call Workers AI for summary
    const prompt = `You are a concise summarizer. Given this YouTube video transcript, provide:

1. A clear 2-3 sentence summary of the video
2. The key points (5-8 bullet points covering the most important ideas)
3. Any action items or takeaways the viewer should note

Format your response EXACTLY like this (use these exact headers):

## Summary
[Your 2-3 sentence summary here]

## Key Points
- [Point 1]
- [Point 2]
...

## Takeaways
- [Takeaway 1]
- [Takeaway 2]
...

Video: "${transcript.title}" by ${transcript.channel}

Transcript:
${truncatedText}`;

    const aiResponse = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1024,
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
