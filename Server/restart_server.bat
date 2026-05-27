@echo off

for /f "tokens=5" %%a in ('netstat -ano ^| findstr :499 ^| findstr LISTENING') do (
    taskkill /PID %%a /F >nul 2>&1
)

timeout /t 1 >nul

venv\Scripts\python.exe app.py