@echo off
title Daydreamin Backend Server and Cloudflare Tunnel

echo =======================================================
echo Starting Daydreamin Backend and Cloudflare Tunnel...
echo =======================================================

:: Kill any existing FastAPI server on port 499 and any running cloudflared process
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :499 ^| findstr LISTENING') do (
    taskkill /PID %%a /F >nul 2>&1
)
taskkill /IM cloudflared.exe /F >nul 2>&1

:: Delete old cloudflared log to prevent detecting a stale tunnel URL on startup
if exist "%~dp0Server\data\cloudflared.log" del /f /q "%~dp0Server\data\cloudflared.log"

:: Start FastAPI server in a new window
echo Starting FastAPI server on port 499...
start "FastAPI Server" cmd /c "cd /d "%~dp0Server" && venv\Scripts\python.exe app.py"

:: Start Cloudflare Tunnel in a new window
echo Starting Cloudflare Tunnel...
start "Cloudflare Tunnel" cmd /c "C:\Program Files (x86)\cloudflared\cloudflared.exe tunnel --url http://localhost:499 --loglevel info --logfile Server/data/cloudflared.log"

echo.
echo =======================================================
echo Backend server is running on http://localhost:499
echo Cloudflare Tunnel has been started.
echo.
echo The new URL will be automatically detected and registered
echo to your web app! You can close this window now or keep it open.
echo =======================================================
pause
