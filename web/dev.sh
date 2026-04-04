#!/bin/bash
export PATH="/opt/homebrew/Cellar/node/25.8.2/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")"
npx wrangler dev --port 8787
