@echo off
rem The noodlegraph demo with the Python runtime: starts the small host and opens the page.
cd /d "%~dp0"
python -c "import pydantic, yaml" 2>nul || python -m pip install pydantic PyYAML
start "" http://localhost:8765
python server.py
pause
