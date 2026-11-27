#!/bin/sh
# Noodlegraph: serves this folder and tells you where to look.
#   ./start.sh            documentation and demo on http://localhost:8760
#   ./start.sh 9000       the same on another port
#   ./start.sh python     the demo with the Python runtime instead (http://localhost:8765)
cd "$(dirname "$0")" || exit 1

if [ "$1" = "python" ]; then
  exec sh runtimes/python/demo/start.sh
fi

PORT="${1:-8760}"
if command -v python3 >/dev/null 2>&1; then PYTHON=python3
elif command -v python >/dev/null 2>&1; then PYTHON=python
else
  echo "Noodlegraph needs something that serves files. Install Python 3, or run:  npx serve -l $PORT"
  exit 1
fi

URL="http://localhost:$PORT"
echo "Noodlegraph"
echo "  Documentation   $URL/docs/"
echo "  Demo            $URL/demo/"
echo "  Ctrl+C stops it."

# open the browser once the server is up (whichever opener this system has)
(
  sleep 1
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL/docs/"
  elif command -v open >/dev/null 2>&1; then open "$URL/docs/"
  fi
) >/dev/null 2>&1 &

exec "$PYTHON" -m http.server "$PORT" --bind 127.0.0.1
