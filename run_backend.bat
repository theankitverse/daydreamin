@echo off
title Daydreamin Backend Server and Cloudflare Tunnel

echo =======================================================
echo Starting Daydreamin Backend and Cloudflare Tunnel...
echo =======================================================

:: Kill any existing FastAPI server on port 499
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :499 ^| findstr LISTENING') do (
    taskkill /PID %%a /F >nul 2>&1
)

:: Start FastAPI server in a new window
echo Starting FastAPI server on port 499...
start "FastAPI Server" cmd /c "cd /d "%~dp0Server" && venv\Scripts\python.exe app.py"

:: Start Cloudflare Tunnel in a new window
echo Starting Cloudflare Tunnel...
start "Cloudflare Tunnel" cmd /c "C:\Program Files (x86)\cloudflared\cloudflared.exe tunnel --url http://localhost:499"

echo.
echo =======================================================
echo Backend server is running on http://localhost:499
echo Cloudflare Tunnel window is open. Look in that window
echo for the line starting with:
echo    https://xxxxxxxx.trycloudflare.com
echo.
echo Paste that URL into the app's settings panel (click the 
echo gear/settings icon in the top right of the web app) 
echo to connect instantly without redeploying.
echo =======================================================
pause
