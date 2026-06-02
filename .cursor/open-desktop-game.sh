#!/usr/bin/env bash
# Opens Blade Arena in Chrome on the cloud VM desktop (not the IDE port-forward pane).
set -euo pipefail

GAME_URL="http://127.0.0.1:5173/?from=desktop"
MAX_WAIT_SEC=120

echo "Waiting for dev server at ${GAME_URL} ..."

for ((second = 0; second < MAX_WAIT_SEC; second += 1)); do
  if curl -sf -o /dev/null "${GAME_URL}"; then
    echo "Dev server is up."
    break
  fi
  sleep 1
done

if ! curl -sf -o /dev/null "${GAME_URL}"; then
  echo "Dev server did not start in time. Run: npm run dev"
  exit 1
fi

if command -v google-chrome >/dev/null 2>&1; then
  # --app= drops browser tabs/UI so Desktop shows the game, not a generic browser screenshot.
  exec google-chrome \
    --new-window \
    --no-first-run \
    --no-default-browser-check \
    --disable-session-crashed-bubble \
    --app="${GAME_URL}"
elif command -v chromium >/dev/null 2>&1; then
  exec chromium --new-window --app="${GAME_URL}"
elif command -v xdg-open >/dev/null 2>&1; then
  exec xdg-open "${GAME_URL}"
else
  echo "No Chrome found. Open ${GAME_URL} manually in the VM browser."
  exit 1
fi
