#!/usr/bin/env bash
# Opens Blade Arena in Chrome on the cloud Desktop (not the mountain wallpaper).
set -euo pipefail

GAME_URL="${GAME_URL:-http://127.0.0.1:5173/?from=desktop}"
MAX_WAIT=45

echo "Waiting for Vite on port 5173..."
for ((i = 0; i < MAX_WAIT; i++)); do
  if curl -sf -o /dev/null "http://127.0.0.1:5173/" 2>/dev/null; then
    break
  fi
  sleep 1
done

if ! curl -sf -o /dev/null "http://127.0.0.1:5173/" 2>/dev/null; then
  echo "Dev server not running. Start: npm run dev"
  exit 1
fi

if command -v google-chrome >/dev/null 2>&1; then
  exec google-chrome --new-window --app="$GAME_URL" 2>/dev/null || \
    exec google-chrome --new-window "$GAME_URL"
elif command -v chromium-browser >/dev/null 2>&1; then
  exec chromium-browser --new-window --app="$GAME_URL"
else
  echo "Open this URL in the Desktop browser: $GAME_URL"
  exit 0
fi
