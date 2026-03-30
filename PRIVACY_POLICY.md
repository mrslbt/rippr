# Privacy Policy — rippr

**Last updated:** March 30, 2026

## Overview

rippr is a Chrome extension that extracts transcripts from YouTube videos. This privacy policy explains what data rippr accesses, how it's used, and what is stored.

## Data Collection

**rippr does not collect, store, or transmit any user data.**

No personal information, browsing history, analytics, or telemetry is collected — ever.

## What rippr accesses

rippr accesses the following, solely to extract video transcripts:

- **YouTube video pages** you visit (to display the rippr button and read caption data)
- **YouTube's caption API** (to fetch transcript text for the video you request)
- **Your clipboard** (only when you click the paste button in the popup — never read automatically)

All processing happens locally in your browser. Transcript files are saved directly to your device via your browser's download mechanism.

## Data Storage

rippr does not store any data. No cookies, no local storage, no databases, no accounts. Each use is stateless.

## Third-Party Services

rippr does not communicate with any third-party servers. The only network requests are to YouTube's own APIs (`youtube.com`) to fetch caption data for the video you requested.

## Permissions Explained

| Permission | Why it's needed |
|-----------|----------------|
| `activeTab` | To detect if you're on a YouTube video page |
| `declarativeNetRequest` | To set required request headers for YouTube's caption API |
| `host_permissions` (youtube.com, googlevideo.com) | To fetch transcript data from YouTube's servers |

## Changes

If this policy changes, the update will be posted here with a new date.

## Contact

For questions about this privacy policy, open an issue at [github.com/mrslbt/rippr](https://github.com/mrslbt/rippr).
