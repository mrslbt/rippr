// ── rippr Shared Utilities v2.0 ─────────────────────
// Shared between content.js and popup.js to avoid duplication.

const rippr = (() => {
  "use strict";

  // ── Video ID extraction ─────────────────────────────
  function extractVideoId(url) {
    if (!url) return null;
    url = url.trim();

    // youtu.be/ID
    let match = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
    if (match) return match[1];

    // youtube.com/watch?v=ID
    match = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    if (match) return match[1];

    // youtube.com/embed/ID or /v/ID or /shorts/ID
    match = url.match(/\/(?:embed|v|shorts)\/([a-zA-Z0-9_-]{11})/);
    if (match) return match[1];

    // Raw 11-char video ID
    match = url.match(/^([a-zA-Z0-9_-]{11})$/);
    if (match) return match[1];

    return null;
  }

  // ── HTML entity decoding ────────────────────────────
  function decodeHtmlEntities(text) {
    const el = document.createElement("textarea");
    el.innerHTML = text;
    return el.value;
  }

  // ── Filename sanitization ───────────────────────────
  function sanitizeFilename(name) {
    return name
      .replace(/[<>:"/\\|?*]+/g, "")
      .trim()
      .substring(0, 200);
  }

  // ── XML caption parsing ─────────────────────────────
  // Supports timedtext (<text start dur>) and srv3 (<p t d><s>)
  function parseXmlCaptions(xmlText) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, "text/xml");

    // Standard timedtext format
    let textNodes = xmlDoc.querySelectorAll("text");

    // srv3 format uses <p> elements
    if (textNodes.length === 0) {
      textNodes = xmlDoc.querySelectorAll("p");
    }

    if (textNodes.length === 0) return null;

    const segments = [];
    textNodes.forEach((node) => {
      const start = parseFloat(
        node.getAttribute("start") || node.getAttribute("t") || "0"
      );
      const dur = parseFloat(
        node.getAttribute("dur") || node.getAttribute("d") || "0"
      );
      // srv3: time in ms; timedtext: time in seconds
      const isMs = node.getAttribute("t") !== null;
      const startMs = isMs ? start : start * 1000;
      const durMs = isMs ? dur : dur * 1000;

      const text = decodeHtmlEntities(node.textContent || "");
      if (text.trim()) {
        segments.push({
          startMs: Math.round(startMs),
          durationMs: Math.round(durMs),
          text: text.trim(),
        });
      }
    });

    return segments.length > 0 ? segments : null;
  }

  // ── Build formatted output ──────────────────────────
  function buildOutput(data, format, includeTimestamps = false) {
    const { title, channel, date, url, language, segments } = data;

    // Normalize start time to seconds regardless of input shape
    // content.js sends {startMs, durationMs}, background.js sends {start, duration}
    function startSec(s) {
      if (s.startMs != null) return s.startMs / 1000;
      if (s.start != null) return s.start;
      return 0;
    }
    function durSec(s) {
      if (s.durationMs != null) return s.durationMs / 1000;
      if (s.duration != null) return s.duration;
      return 0;
    }

    if (format === "json") {
      return JSON.stringify(
        {
          title,
          channel,
          ...(date ? { date } : {}),
          url,
          language,
          segments: segments.map((s) => ({
            start: startSec(s),
            duration: durSec(s),
            text: s.text,
          })),
          fullText: segments.map((s) => s.text).join(" "),
        },
        null,
        2
      );
    }

    const lines = [];

    if (format === "md") {
      lines.push(`# ${title}`, "");
      lines.push(`**Channel:** ${channel}`);
      if (date) lines.push(`**Date:** ${date}`);
      lines.push(`**URL:** ${url}`);
      lines.push(`**Language:** ${language}`, "");
      lines.push("---", "");
    } else {
      lines.push(`Title: ${title}`);
      lines.push(`Channel: ${channel}`);
      if (date) lines.push(`Date: ${date}`);
      lines.push(`URL: ${url}`);
      lines.push(`Language: ${language}`, "");
      lines.push("---", "");
    }

    for (const seg of segments) {
      if (includeTimestamps) {
        const totalSec = startSec(seg);
        const mins = Math.floor(totalSec / 60);
        const secs = Math.floor(totalSec % 60).toString().padStart(2, "0");
        lines.push(`[${mins}:${secs}] ${seg.text}`);
      } else {
        lines.push(seg.text);
      }
    }

    let output = lines.join("\n");

    // For RAG: join all text into a single block
    if (!includeTimestamps && format === "txt") {
      const parts = output.split("---\n\n");
      if (parts.length === 2) {
        const bodyLines = parts[1].split("\n").filter((l) => l.trim());
        output = parts[0] + "---\n\n" + bodyLines.join(" ");
      }
    }

    return output;
  }

  // ── Trigger file download ───────────────────────────
  function downloadFile(content, filename) {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return {
    extractVideoId,
    decodeHtmlEntities,
    sanitizeFilename,
    parseXmlCaptions,
    buildOutput,
    downloadFile,
  };
})();
