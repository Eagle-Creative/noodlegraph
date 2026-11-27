# noodlegraph runtime for Python

Checks and runs the graphs the noodlegraph editor draws, as the [spec](../../spec/SPEC.md) says.
Needs Python 3.11+, pydantic and PyYAML. See the [project README](../../README.md).

```
pip install -e runtimes/python                 # from the project folder
python -m pytest runtimes/python               # the tests, the shared test graphs included
python runtimes/python/demo/server.py          # a host as a server: editor in the browser, engine in Python
```
