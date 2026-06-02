#!/usr/bin/env bash
# Wait for Vite, then open Blade Arena in the VM desktop browser (Cursor Desktop tab).
set -euo pipefail

URL="${BLADE_ARENA_URL:-http://127.0.0.1:5173/}"

for _ in $(seq 1 120); do
  if curl -sf -o /dev/null "$URL"; then
    google-chrome --new-window "$URL" \
      --no-first-run \
      --no-default-browser-check \
      2>/dev/null || xdg-open "$URL" 2>/dev/null || true
    exit 0
  fi
  sleep 1
done

echo "Blade Arena dev server did not become ready at $URL" >&2
exit 0
