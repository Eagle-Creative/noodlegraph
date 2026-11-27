@echo off
rem Noodlegraph: serves this folder and opens the documentation. The demo is at /demo/.
cd /d "%~dp0"
echo Noodlegraph
echo   Documentation   http://localhost:8760/docs/
echo   Demo            http://localhost:8760/demo/
echo   Close this window to stop it.
start "" http://localhost:8760/docs/
python -m http.server 8760 --bind 127.0.0.1
pause
