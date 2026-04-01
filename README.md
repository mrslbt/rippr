<p align="center">
  <img src="youtubetotext/icons/icon128.png" width="80" height="80" alt="rippr icon" />
</p>

<h1 align="center">rippr</h1>

<p align="center">
  <strong>YouTube transcript ripper. Built for RAG and LLM workflows.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/manifest-v3-blue" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/version-2.0.0-green" alt="Version 2.0.0" />
  <img src="https://img.shields.io/badge/license-MIT-yellow" alt="MIT License" />
</p>

---

## What it does

rippr extracts transcripts from any YouTube video and saves them as clean, structured files. One click on the video page, or paste a URL into the popup.

**Output formats:**
- **RAG (.txt)** - single continuous text block, optimized for chunking and embedding
- **Structured (.json)** - timestamped segments with metadata
- **Readable (.md)** - markdown with headers and formatting

## Features

- In-page button that appears directly on YouTube watch pages
- Popup interface — paste any YouTube URL from anywhere
- Multi-language support with auto-detection
- Auto-generated caption indicator
- Timestamp toggle
- Multiple fallback strategies for reliable extraction

## Install

### From source (developer)

1. Clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked**
5. Select the `youtubetotext` folder

## How it works

rippr uses a multi-strategy approach to extract transcripts:

1. **Innertube API** - YouTube's internal player API (primary method)
2. **HTML scraping** - parses `ytInitialPlayerResponse` from the page source
3. **Transcript panel** - opens YouTube's built-in transcript panel as a last resort

Caption XML is parsed in multiple formats (srv3, timedtext, JSON3) for maximum compatibility.

## Architecture

```
youtubetotext/
  manifest.json      Manifest V3 config
  shared.js          Shared utilities (parsing, formatting, download)
  background.js      Service worker — Innertube API + HTML scraping
  content.js         In-page button UI + transcript extraction
  content.css        Styles for the YouTube page integration
  popup.html         Extension popup interface
  popup.js           Popup logic
  popup.css          Popup styles
  rules.json         Declarative net request rules
  icons/             Extension icons (16, 48, 128)
```

## Privacy

rippr runs entirely in your browser. No data is sent to any external server. Transcripts are downloaded directly to your machine. The extension only communicates with YouTube's own APIs to fetch caption data.

## License

MIT
