# noodlegraph runtime for Python

Checks and runs the graphs the noodlegraph editor draws, as the [spec](../../spec/SPEC.md) says.
Needs Python 3.11+, pydantic and PyYAML. See the [project README](../../README.md).

```
python -m venv .venv                           # from the project folder: its own environment
.venv/bin/pip install -e "runtimes/python[dev]"       # Windows: .venv\Scripts\pip
.venv/bin/python -m pytest runtimes/python     # the tests, the shared test graphs included
./start.sh python                              # the demo: editor in the browser, engine in Python
```

The demo's start scripts (`./start.sh python`, `runtimes/python/demo/start.bat`) make `.venv` in
the project folder on their first start and install pydantic and PyYAML there. Nothing goes into
your system's Python.
