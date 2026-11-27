@echo off
rem The noodlegraph demo with the Python runtime: starts the small host and opens the page.
rem What it needs (pydantic, PyYAML) goes into .venv in the project folder, not into your system.
setlocal
cd /d "%~dp0"
set "VENV=%~dp0..\..\..\.venv"
if not exist "%VENV%\Scripts\python.exe" (
  echo First start: making .venv in the project folder
  python -m venv "%VENV%"
  if errorlevel 1 (
    echo Could not make the environment. Install Python 3.11 or newer from python.org, then start this again.
    pause
    exit /b 1
  )
)
"%VENV%\Scripts\python.exe" -c "import pydantic, yaml" 2>nul
if errorlevel 1 (
  echo Installing pydantic and PyYAML into .venv
  "%VENV%\Scripts\python.exe" -m pip install --quiet "pydantic>=2.7" "PyYAML>=6.0"
  if errorlevel 1 (
    echo Could not install them. Check the internet connection, then start this again.
    pause
    exit /b 1
  )
)
start "" http://localhost:8765
"%VENV%\Scripts\python.exe" server.py
pause
