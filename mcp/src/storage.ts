// rippr transcript storage
// Handles writing saved transcripts to disk and enumerating previously ripped ones.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Segment } from "./transcript.js";

export const DEFAULT_SAVE_DIR = path.join(homedir(), "rippr", "transcripts");
const CUSTOM_PATH_REGISTRY = path.join(DEFAULT_SAVE_DIR, ".saved-paths.json");

function isTranscriptFilename(filename: string): boolean {
  if (filename.startsWith(".")) return false;
  return /\.(md|json)$/i.test(filename);
}

export interface SaveArgs {
  videoId: string;
  title: string;
  channel: string;
  language: string;
  isAuto: boolean;
  segments: Segment[];
  format: "text" | "segments";
  savePath?: string;
}

export interface SaveResult {
  path: string;
  filename: string;
}

export async function saveTranscript(args: SaveArgs): Promise<SaveResult> {
  const ext = args.format === "segments" ? "json" : "md";
  const slug = slugify(args.title);
  const defaultFilename = `${slug}_${args.videoId}.${ext}`;

  let targetPath: string;
  if (args.savePath && args.savePath.trim().length > 0) {
    const expanded = expandHome(args.savePath.trim());
    let treatAsDir = false;
    try {
      const stat = await fs.stat(expanded);
      treatAsDir = stat.isDirectory();
    } catch {
      // Path doesn't exist yet. If it has a known file extension, treat as file.
      treatAsDir = !/\.(md|json|txt)$/i.test(expanded);
    }
    targetPath = treatAsDir ? path.join(expanded, defaultFilename) : expanded;
  } else {
    targetPath = path.join(DEFAULT_SAVE_DIR, defaultFilename);
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  const contents =
    args.format === "segments"
      ? renderSegmentsJson(args)
      : renderMarkdown(args);

  await fs.writeFile(targetPath, contents, "utf8");
  await registerSavedPath(targetPath);

  return {
    path: targetPath,
    filename: path.basename(targetPath),
  };
}

export async function listSavedTranscripts(): Promise<SaveResult[]> {
  const savedPaths = new Set<string>();

  try {
    const entries = await fs.readdir(DEFAULT_SAVE_DIR);
    for (const entry of entries) {
      if (isTranscriptFilename(entry)) {
        savedPaths.add(path.join(DEFAULT_SAVE_DIR, entry));
      }
    }
  } catch {
    // Ignore missing default directory.
  }

  for (const savedPath of await loadRegisteredPaths()) {
    if (isTranscriptFilename(path.basename(savedPath))) {
      savedPaths.add(savedPath);
    }
  }

  const results = await Promise.all(
    [...savedPaths].sort().map(async (savedPath) => {
      try {
        const stat = await fs.stat(savedPath);
        if (!stat.isFile()) return null;
        return {
          path: savedPath,
          filename: path.basename(savedPath),
        };
      } catch {
        return null;
      }
    })
  );

  return results.filter((entry): entry is SaveResult => entry !== null);
}

export async function readSavedTranscript(uri: string): Promise<string> {
  const filePath = uri.startsWith("file://") ? fileURLToPath(uri) : uri;
  const resolved = path.resolve(filePath);
  if (!(await isAllowedTranscriptPath(resolved))) {
    throw new Error(`Refused to read unsaved transcript path: ${resolved}`);
  }
  return fs.readFile(resolved, "utf8");
}

async function isAllowedTranscriptPath(resolvedPath: string): Promise<boolean> {
  // Block internal metadata files (the custom-path registry, any dotfile).
  if (path.basename(resolvedPath).startsWith(".")) return false;

  const allowedRoot = path.resolve(DEFAULT_SAVE_DIR);
  if (
    resolvedPath === allowedRoot ||
    resolvedPath.startsWith(allowedRoot + path.sep)
  ) {
    return true;
  }

  const registered = await loadRegisteredPaths();
  return registered.has(resolvedPath);
}

async function registerSavedPath(savedPath: string): Promise<void> {
  const resolvedPath = path.resolve(savedPath);
  const allowedRoot = path.resolve(DEFAULT_SAVE_DIR);
  if (
    resolvedPath === allowedRoot ||
    resolvedPath.startsWith(allowedRoot + path.sep)
  ) {
    return;
  }

  await fs.mkdir(DEFAULT_SAVE_DIR, { recursive: true });
  const registered = await loadRegisteredPaths();
  registered.add(resolvedPath);
  await fs.writeFile(
    CUSTOM_PATH_REGISTRY,
    JSON.stringify([...registered].sort(), null, 2) + "\n",
    "utf8"
  );
}

async function loadRegisteredPaths(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(CUSTOM_PATH_REGISTRY, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(
      parsed
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => path.resolve(entry))
    );
  } catch {
    return new Set();
  }
}

function renderMarkdown(args: SaveArgs): string {
  const fullText = args.segments.map((s) => s.text).join(" ");
  const duration = args.segments.reduce(
    (acc, s) => Math.max(acc, s.start + s.duration),
    0
  );
  return [
    "---",
    `title: ${yamlEscape(args.title)}`,
    `channel: ${yamlEscape(args.channel)}`,
    `language: ${args.language}${args.isAuto ? " (auto-generated)" : ""}`,
    `videoId: ${args.videoId}`,
    `videoUrl: https://www.youtube.com/watch?v=${args.videoId}`,
    `durationSeconds: ${Math.round(duration)}`,
    `rippedAt: ${new Date().toISOString()}`,
    "---",
    "",
    `# ${args.title}`,
    "",
    `> by ${args.channel}`,
    "",
    fullText,
    "",
  ].join("\n");
}

function renderSegmentsJson(args: SaveArgs): string {
  return JSON.stringify(
    {
      title: args.title,
      channel: args.channel,
      language: args.language,
      isAutoGenerated: args.isAuto,
      videoId: args.videoId,
      videoUrl: `https://www.youtube.com/watch?v=${args.videoId}`,
      segmentCount: args.segments.length,
      segments: args.segments,
      rippedAt: new Date().toISOString(),
    },
    null,
    2
  );
}

function slugify(text: string): string {
  // Unicode-aware: keeps letters (including CJK, Cyrillic, etc.) and numbers,
  // replaces whitespace runs with hyphens, strips everything else.
  const slug = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return slug || "transcript";
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

function yamlEscape(s: string): string {
  if (/[:#\n"'\\]/.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}
