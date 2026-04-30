#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, statSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const INFO = "\x1b[36m·\x1b[0m";

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`${PASS} ${label}`);
  } else {
    failures++;
    console.log(`${FAIL} ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const TEST_VIDEO = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
const tmpSaveDir = mkdtempSync(path.join(tmpdir(), "rippr-test-"));

console.log(`${INFO} Test save dir: ${tmpSaveDir}`);

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
});

const client = new Client(
  { name: "rippr-integration-test", version: "1.0.0" },
  { capabilities: {} }
);

try {
  await client.connect(transport);
  console.log(`${PASS} Server connected`);

  const tools = await client.listTools();
  check(
    "tools/list returns rip_transcript",
    tools.tools.some((t) => t.name === "rip_transcript")
  );
  check(
    "rip_transcript has url in inputSchema.required",
    tools.tools[0]?.inputSchema?.required?.includes("url")
  );

  const prompts = await client.listPrompts();
  const promptNames = prompts.prompts.map((p) => p.name);
  for (const name of [
    "get_transcript",
    "summarize_video",
    "extract_quotes",
    "compare_videos",
    "research_topic",
  ]) {
    check(`prompts/list contains ${name}`, promptNames.includes(name));
  }

  const resources = await client.listResources();
  check(
    "resources/list contains rippr://formats",
    resources.resources.some((r) => r.uri === "rippr://formats")
  );

  const formats = await client.readResource({ uri: "rippr://formats" });
  const formatsBody = JSON.parse(formats.contents[0].text);
  check(
    "rippr://formats lists text and segments",
    formatsBody.formats.length === 2 &&
      formatsBody.formats.some((f) => f.name === "text") &&
      formatsBody.formats.some((f) => f.name === "segments")
  );

  console.log(`${INFO} Calling rip_transcript on ${TEST_VIDEO}`);
  const result = await client.callTool({
    name: "rip_transcript",
    arguments: {
      url: TEST_VIDEO,
      save_path: tmpSaveDir,
    },
  });

  check("rip_transcript did not error", !result.isError);
  const resourceLink = result.content.find((c) => c.type === "resource_link");
  const summaryText = result.content.find((c) => c.type === "text");

  check("response contains a resource_link", !!resourceLink);
  check("response contains a text summary", !!summaryText?.text);

  if (resourceLink) {
    const filePath = decodeURIComponent(
      resourceLink.uri.replace(/^file:\/\//, "")
    );
    check("saved file is under tmpSaveDir", filePath.startsWith(tmpSaveDir));

    let stat;
    try {
      stat = statSync(filePath);
    } catch (e) {
      check("saved file exists on disk", false, e.message);
    }
    if (stat) {
      check("saved file is non-empty", stat.size > 0, `${stat.size} bytes`);

      const body = readFileSync(filePath, "utf-8");
      check("saved file looks like a transcript", body.length > 100);
      check(
        "saved file has YAML frontmatter or JSON shape",
        body.startsWith("---") || body.trim().startsWith("{") || body.trim().startsWith("[")
      );
    }
  }

  console.log(`${INFO} Closing client`);
  await client.close();
} catch (err) {
  console.log(`${FAIL} Unhandled error: ${err.message}`);
  failures++;
} finally {
  try {
    rmSync(tmpSaveDir, { recursive: true, force: true });
  } catch {}
}

if (failures > 0) {
  console.log(`\n${FAIL} ${failures} check(s) failed`);
  process.exit(1);
}
console.log(`\n${PASS} All checks passed`);
process.exit(0);
