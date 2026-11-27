#!/bin/sh
# The noodlegraph demo with the Python runtime. Then open http://localhost:8765
# What it needs (pydantic, PyYAML) goes into .venv in the project folder, not into your system.
cd "$(dirname "$0")" || exit 1
ROOT="$(cd ../../.. && pwd)"
VENV="$ROOT/.venv"

if command -v python3 >/dev/null 2>&1; then PYTHON=python3
elif command -v python >/dev/null 2>&1; then PYTHON=python
else echo "Noodlegraph's Python demo needs Python 3.11 or newer. Install it, then start this again."; exit 1
fi

if [ ! -x "$VENV/bin/python" ]; then
  echo "First start: making $VENV"
  "$PYTHON" -m venv "$VENV" || {
    echo "Could not make the environment. On Debian or Ubuntu run:  sudo apt install python3-venv"
    exit 1
  }
fi
if ! "$VENV/bin/python" -c "import pydantic, yaml" 2>/dev/null; then
  echo "Installing pydantic and PyYAML into $VENV"
  "$VENV/bin/python" -m pip install --quiet "pydantic>=2.7" "PyYAML>=6.0" || {
    echo "Could not install them. Check the internet connection, then start this again."
    exit 1
  }
fi
exec "$VENV/bin/python" server.py "$@"
