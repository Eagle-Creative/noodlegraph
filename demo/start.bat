@echo off
rem The noodlegraph demo: everything runs in the browser; this only serves the files.
cd /d "%~dp0.."
start "" http://localhost:8760/demo/
python -m http.server 8760 --bind 127.0.0.1
pause
