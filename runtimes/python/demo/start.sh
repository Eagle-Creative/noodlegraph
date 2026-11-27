#!/bin/sh
# The noodlegraph demo with the Python runtime. Then open http://localhost:8765
cd "$(dirname "$0")" || exit 1
python3 -c "import pydantic, yaml" 2>/dev/null || python3 -m pip install pydantic PyYAML
exec python3 server.py "$@"
