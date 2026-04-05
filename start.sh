#!/bin/bash
# SoundMap — Start Script

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Pass through GEMINI_API_KEY from environment
export GEMINI_API_KEY="${GEMINI_API_KEY:-}"

if [ -z "$GEMINI_API_KEY" ]; then
  echo "⚠️  GEMINI_API_KEY not set. Set it in your environment or .env.local"
fi

# Use .env.local if exists
if [ -f .env.local ]; then
  export $(grep -v '^#' .env.local | xargs)
fi

PORT="${PORT:-3099}"

echo "🎵 Starting SoundMap on port $PORT..."
npm run start -- -p "$PORT"
