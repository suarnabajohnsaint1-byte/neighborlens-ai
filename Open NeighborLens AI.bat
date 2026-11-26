@echo off
setlocal enabledelayedexpansion

title NeighborLens AI Launcher

:: 1. Determine working directory (find folder containing server\app.js)
set "APP_DIR=%~dp0"
if exist "%APP_DIR%server\app.js" (
    cd /d "%APP_DIR%"
) else if exist "%APP_DIR%Neighborlens AI - New\server\app.js" (
    cd /d "%APP_DIR%Neighborlens AI - New"
) else if exist "%APP_DIR%..\server\app.js" (
    cd /d "%APP_DIR%.."
)

echo ===================================================
echo   NeighborLens AI - Starting Complete System
echo ===================================================
echo Current working directory: %CD%

:: 2. Locate Python executable (check .venv or system python)
set "PYTHON_EXE="
if exist "%CD%\.venv\Scripts\python.exe" set "PYTHON_EXE=%CD%\.venv\Scripts\python.exe"
if not defined PYTHON_EXE if exist "%CD%\..\.venv\Scripts\python.exe" set "PYTHON_EXE=%CD%\..\.venv\Scripts\python.exe"
if not defined PYTHON_EXE if exist "%CD%\..\..\.venv\Scripts\python.exe" set "PYTHON_EXE=%CD%\..\..\.venv\Scripts\python.exe"
if not defined PYTHON_EXE where python >nul 2>&1 && set "PYTHON_EXE=python"

:: 3. Check YOLO weights & launch Python YOLO server if weights exist
set "YOLO_WEIGHTS=%NEIGHBORLENS_YOLO_WEIGHTS%"
if not defined YOLO_WEIGHTS if exist "models\production\best.pt" set "YOLO_WEIGHTS=models\production\best.pt"

set "DAMAGE_INFERENCE_URL="
set "DAMAGE_MIN_CONFIDENCE=0.30"

if defined YOLO_WEIGHTS if defined PYTHON_EXE (
    echo [AI] Using model weights: %YOLO_WEIGHTS%
    set "DAMAGE_INFERENCE_URL=http://127.0.0.1:8000/predict"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "try { (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8000/docs' -TimeoutSec 1).StatusCode | Out-Null; exit 0 } catch { exit 1 }"
    if errorlevel 1 (
        echo [AI] Starting YOLO FastAPI inference service on port 8000...
        start "NeighborLens YOLO AI" /min cmd /c ""%PYTHON_EXE%" ai\inference\inference_api.py --weights %YOLO_WEIGHTS% --host 0.0.0.0 --port 8000 --confidence 0.30 --imgsz 640"
    ) else (
        echo [AI] YOLO inference service already running on port 8000.
    )
) else (
    echo [AI] Note: Python or weights not detected, server will operate in standard mode.
)

:: 4. Check & Start Node.js backend server on port 3000
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { (Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3000/api/health' -TimeoutSec 1).StatusCode | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
    echo [Server] Starting Node.js backend server on port 3000...
    start "NeighborLens Server" /min cmd /c "set DAMAGE_INFERENCE_URL=%DAMAGE_INFERENCE_URL%&& set DAMAGE_MIN_CONFIDENCE=%DAMAGE_MIN_CONFIDENCE%&& set HOST=0.0.0.0&& set PORT=3000&& node server/app.js"
    ping -n 3 127.0.0.1 >nul
) else (
    echo [Server] Node.js server is already running on port 3000.
)

:: 5. Detect private IPv4 address for mobile access
for /f "delims=" %%I in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp | Where-Object {$_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*'} | Select-Object -First 1 -ExpandProperty IPAddress)"') do set "LAN_IP=%%I"
if not defined LAN_IP set "LAN_IP=localhost"
set "PHONE_URL=http://%LAN_IP%:3000/login.html"

:: Copy mobile link to clipboard
echo %PHONE_URL% | clip

echo ===================================================
echo   SYSTEM ONLINE ^& READY!
echo ===================================================
echo   Desktop URL:   http://localhost:3000/login.html
echo   Mobile URL:    %PHONE_URL%
echo ===================================================
echo The mobile link has been COPIED to your clipboard.
echo You can paste and open it on your smartphone browser!
echo.

:: 6. Locate Google Chrome executable across standard installation directories
set "CHROME_EXE="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME_EXE if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME_EXE if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%LocalAppData%\Google\Chrome\Application\chrome.exe"

echo Opening NeighborLens AI in Chrome...
if defined CHROME_EXE (
    start "" "%CHROME_EXE%" "http://localhost:3000/login.html"
) else (
    start "" "http://localhost:3000/login.html"
)

endlocal
