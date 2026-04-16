<p align="center">
  <img src="youtubetotext/icons/icon128.png" width="80" height="80" alt="rippr icon" />
</p>

<h1 align="center">rippr</h1>

<p align="center">
  <strong>YouTube transcript ripper for humans and AI agents.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/rippr-mcp"><img src="https://img.shields.io/npm/v/rippr-mcp?color=green&label=MCP%20Server" alt="npm" /></a>
  <img src="https://img.shields.io/badge/manifest-v3-blue" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/license-MIT-yellow" alt="MIT License" />
  <a href="https://lobehub.com/mcp/mrslbt-rippr"><img src="https://lobehub.com/badge/mcp/mrslbt-rippr" alt="LobeHub MCP" /></a>
  <a href="https://glama.ai/mcp/servers/mrslbt/rippr"><img src="https://glama.ai/mcp/servers/mrslbt/rippr/badges/score.svg" alt="Glama MCP" /></a>
</p>

<p align="center">
  <a href="https://rippr.me"><strong>Website</strong></a> · <a href="https://chromewebstore.google.com/detail/rippr"><strong>Chrome Web Store</strong></a> · <a href="https://www.npmjs.com/package/rippr-mcp"><strong>MCP Server (npm)</strong></a>
</p>

---

## Three ways to use rippr

### 🌐 Website — [rippr.me](https://rippr.me)
Paste a YouTube URL, get the transcript. Clean text, no signup.

### 🧩 Chrome Extension — [Chrome Web Store](https://chromewebstore.google.com/detail/rippr)
One-click transcript extraction directly on any YouTube page. Multiple output formats (RAG, JSON, Markdown).

### 🤖 MCP Server — [npm](https://www.npmjs.com/package/rippr-mcp)
Connect rippr to Claude, Cursor, or any MCP-compatible AI agent.

```bash
npx rippr-mcp
```

Add to Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "rippr": {
      "command": "npx",
      "args": ["rippr-mcp"]
    }
  }
}
```

Then ask: *"Get the transcript of this YouTube video: [url]"*

---

## Output formats

- **RAG (.txt)** — single continuous text block, optimized for chunking and embedding
- **Structured (.json)** — timestamped segments with metadata
- **Readable (.md)** — markdown with headers and formatting

## How it works

Multi-strategy extraction for maximum reliability:

1. **Innertube API** — YouTube's internal player API (Android client)
2. **HTML scraping** — parses `ytInitialPlayerResponse` from page source
3. **Transcript panel** — opens YouTube's built-in transcript panel as last resort

Caption XML parsed in multiple formats (srv3, timedtext, JSON3). Retry with exponential backoff on transient failures.

## Privacy

Runs entirely on your machine. No data sent to external servers. No accounts, no tracking. Only communicates with YouTube's own APIs.

## More MCPs

| MCP | What it does |
|-----|-------------|
| [Japan UX](https://github.com/mrslbt/japan-ux-mcp) | Japanese UX rules for AI — forms, keigo, typography, trust signals |
| [Rakuten](https://github.com/mrslbt/rakuten-mcp) | Search Rakuten's marketplace, books, and hotels |
| [Xendit](https://github.com/mrslbt/xendit-mcp) | Xendit payment APIs — invoices, disbursements, balances |

## License

MIT
