#!/bin/sh
# The noodlegraph demo: everything runs in the browser; this only serves the files.
# Then open http://localhost:8760/demo/
cd "$(dirname "$0")/.." || exit 1
exec python3 -m http.server 8760 --bind 127.0.0.1
