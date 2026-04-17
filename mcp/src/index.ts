#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
import { extractVideoId, fetchTranscript } from "./transcript.js";
import {
  saveTranscript,
  listSavedTranscripts,
  readSavedTranscript,
  DEFAULT_SAVE_DIR,
} from "./storage.js";

const SERVER_INSTRUCTIONS = `rippr extracts YouTube transcripts and saves them to disk as persistent files.

Default flow for \`rip_transcript\`:
1. Call the tool with a YouTube URL.
2. rippr saves the transcript to ~/rippr/transcripts/<slug>_<videoId>.md and returns a resource_link + metadata (title, channel, duration, word count, saved path, short preview). The full transcript text is NOT included by default.
3. In your reply to the user, always surface the saved file path so they know where the transcript lives.
4. If you later need the transcript contents (for summarization, quotes, search), read the returned resource via the resources API. Do not re-rip the same video.

When to override defaults:
- Pass \`return_text: true\` for tiny clips or when the user explicitly wants the transcript pasted inline.
- Pass \`save_path\` to save to a specific directory or file path.
- Pass \`format: "segments"\` when the user needs timestamped segments (saves JSON instead of Markdown).

Previously ripped transcripts are exposed as \`file://\` resources under the default save directory. Use \`resources/list\` to enumerate them and \`resources/read\` to pull one in, so you can avoid re-ripping a video you already have.`;

const server = new Server(
  {
    name: "rippr-mcp",
    version: "1.2.0",
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
      resources: {},
    },
    instructions: SERVER_INSTRUCTIONS,
  }
);

// ── List available tools ────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "rip_transcript",
      description:
        "Extract the full transcript from a YouTube video. By default, saves the transcript as a Markdown file to disk and returns a resource_link + metadata (title, channel, language, duration, word count, saved path, preview). The full transcript text is NOT returned by default — this keeps context lean and gives the user a persistent file they can reuse. After calling, always tell the user where the file was saved. If you need the transcript text later (summarize, search, extract quotes), read the returned resource rather than re-ripping. Pass return_text: true only for short clips or when the user explicitly asks for the transcript inline. Pass format: 'segments' to save timestamped JSON instead of Markdown.",
      inputSchema: {
        type: "object" as const,
        properties: {
          url: {
            type: "string",
            description:
              "YouTube video URL. Supports any YouTube URL format (watch, youtu.be, embed, shorts, or bare 11-char ID).",
          },
          format: {
            type: "string",
            enum: ["text", "segments"],
            description:
              "Saved file format. 'text' writes a Markdown file with YAML frontmatter and a continuous transcript block (best for RAG/LLM). 'segments' writes a JSON file with timestamped segments (best for chapter markers, precise citations). Default: text.",
          },
          save_path: {
            type: "string",
            description:
              "Optional override for where to save the transcript. Can be an absolute path, a ~/-relative path, a directory (file is named automatically), or a full file path. When you save outside the default directory, the returned resource_link still points to the saved file so it can be read later. Default: ~/rippr/transcripts/<slug>_<videoId>.<ext>",
          },
          return_text: {
            type: "boolean",
            description:
              "If true, include the full transcript text in the tool response alongside the resource_link. Default: false. Use true only for short clips or when the user explicitly wants the transcript inline.",
          },
        },
        required: ["url"],
      },
    },
  ],
}));

// ── Handle tool calls ───────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "rip_transcript") {
    return {
      content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
      isError: true,
    };
  }

  const args = request.params.arguments as {
    url: string;
    format?: "text" | "segments";
    save_path?: string;
    return_text?: boolean;
  };

  const videoId = extractVideoId(args.url);
  if (!videoId) {
    return {
      content: [
        {
          type: "text",
          text: `Could not extract a YouTube video ID from: ${args.url}`,
        },
      ],
      isError: true,
    };
  }

  try {
    const result = await fetchTranscript(videoId);
    const format: "text" | "segments" = args.format || "text";
    const returnText = args.return_text === true;

    const saved = await saveTranscript({
      videoId,
      title: result.title,
      channel: result.channel,
      language: result.language,
      isAuto: result.isAuto,
      segments: result.segments,
      format,
      savePath: args.save_path,
    });

    const fullText = result.segments.map((s) => s.text).join(" ");
    const duration = result.segments.reduce(
      (acc, s) => Math.max(acc, s.start + s.duration),
      0
    );
    const wordCount = fullText.split(/\s+/).filter(Boolean).length;
    const previewSource = fullText.replace(/\s+/g, " ").trim();
    const preview =
      previewSource.slice(0, 240) + (previewSource.length > 240 ? "…" : "");

    const fileUri = pathToFileURL(saved.path).href;
    const mimeType =
      format === "segments" ? "application/json" : "text/markdown";

    const summaryText = [
      `✓ Saved transcript to: ${saved.path}`,
      ``,
      `Title:    ${result.title}`,
      `Channel:  ${result.channel}`,
      `Language: ${result.language}${result.isAuto ? " (auto-generated)" : ""}`,
      `Duration: ${formatDuration(duration)}`,
      `Words:    ${wordCount.toLocaleString()}`,
      `Segments: ${result.segments.length.toLocaleString()}`,
      `URL:      https://www.youtube.com/watch?v=${videoId}`,
      ``,
      `Preview:  ${preview}`,
      ``,
      returnText
        ? `Full transcript included below.`
        : `To read the full transcript, fetch the resource at: ${fileUri}`,
    ].join("\n");

    const content: Array<Record<string, unknown>> = [
      {
        type: "resource_link",
        uri: fileUri,
        name: saved.filename,
        mimeType,
        description: `Transcript of "${result.title}" by ${result.channel} (${wordCount.toLocaleString()} words)`,
      },
      {
        type: "text",
        text: summaryText,
      },
    ];

    if (returnText) {
      content.push({
        type: "text",
        text: `\n--- Full transcript ---\n\n${fullText}`,
      });
    }

    return { content };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `Failed to extract transcript: ${message}`,
        },
      ],
      isError: true,
    };
  }
});

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ── Prompts ────────────────────────────────────────

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: "get_transcript",
      description: "Rip a YouTube video. Saves transcript to disk.",
      arguments: [
        { name: "url", description: "YouTube video URL", required: true },
      ],
    },
    {
      name: "summarize_video",
      description: "Rip a YouTube video and summarize the key points.",
      arguments: [
        { name: "url", description: "YouTube video URL", required: true },
      ],
    },
    {
      name: "extract_quotes",
      description:
        "Rip a YouTube video and pull notable quotes or key statements.",
      arguments: [
        { name: "url", description: "YouTube video URL", required: true },
        {
          name: "topic",
          description: "Topic to focus on (optional)",
          required: false,
        },
      ],
    },
    {
      name: "compare_videos",
      description: "Rip two YouTube videos and compare their content.",
      arguments: [
        {
          name: "url1",
          description: "First YouTube video URL",
          required: true,
        },
        {
          name: "url2",
          description: "Second YouTube video URL",
          required: true,
        },
      ],
    },
    {
      name: "research_topic",
      description:
        "Rip a YouTube video and extract information relevant to a specific topic.",
      arguments: [
        { name: "url", description: "YouTube video URL", required: true },
        { name: "topic", description: "Topic to research", required: true },
      ],
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "get_transcript":
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Rip the transcript of this YouTube video and tell me where it was saved: ${args?.url}`,
            },
          },
        ],
      };
    case "summarize_video":
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Rip the transcript of this YouTube video, read the saved file, and summarize the key points. Include the saved file path in your response: ${args?.url}`,
            },
          },
        ],
      };
    case "extract_quotes":
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: args?.topic
                ? `Rip the transcript of this YouTube video, read the saved file, and pull out notable quotes about "${args.topic}". Include the saved file path in your response: ${args?.url}`
                : `Rip the transcript of this YouTube video, read the saved file, and pull out the most notable quotes. Include the saved file path in your response: ${args?.url}`,
            },
          },
        ],
      };
    case "compare_videos":
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Rip the transcripts of these two YouTube videos, read the saved files, and compare their content. Include both saved file paths in your response:\n1. ${args?.url1}\n2. ${args?.url2}`,
            },
          },
        ],
      };
    case "research_topic":
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Rip the transcript of this YouTube video, read the saved file, and extract all information relevant to "${args?.topic}". Include the saved file path in your response: ${args?.url}`,
            },
          },
        ],
      };
    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
});

// ── Resources ──────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const saved = await listSavedTranscripts();
  return {
    resources: [
      {
        uri: "rippr://formats",
        name: "Output Formats",
        description:
          "Available transcript output formats and when to use each one",
        mimeType: "application/json",
      },
      ...saved.map((s) => ({
        uri: pathToFileURL(s.path).href,
        name: s.filename,
        description: `Saved transcript: ${s.filename}`,
        mimeType: s.filename.toLowerCase().endsWith(".json")
          ? "application/json"
          : "text/markdown",
      })),
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;

  if (uri === "rippr://formats") {
    return {
      contents: [
        {
          uri: "rippr://formats",
          mimeType: "application/json",
          text: JSON.stringify(
            {
              formats: [
                {
                  name: "text",
                  description:
                    "Saved as Markdown with YAML frontmatter. Best for LLM consumption, RAG pipelines, summarization, and human reading.",
                  default: true,
                },
                {
                  name: "segments",
                  description:
                    "Saved as JSON with timestamped segments. Best for referencing specific moments, building chapter markers, or precise citations.",
                  default: false,
                },
              ],
              defaultSaveDir: DEFAULT_SAVE_DIR,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  if (uri.startsWith("file://")) {
    const text = await readSavedTranscript(uri);
    return {
      contents: [
        {
          uri,
          mimeType: uri.toLowerCase().endsWith(".json")
            ? "application/json"
            : "text/markdown",
          text,
        },
      ],
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
});

// ── Start server ────────────────────────────────────
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `rippr-mcp server running on stdio (transcripts → ${DEFAULT_SAVE_DIR})`
  );
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
