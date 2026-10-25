@echo off
title WhatsApp Google Classroom & AI Study Assistant
color 0A

echo ================================================================
echo    WhatsApp Google Classroom ^& AI Study Assistant Launcher
echo    Auto-restart is ON: if the bot ever crashes, it relaunches.
echo ================================================================
echo.

:: 1. Navigate to bot project directory
cd /d "C:\Users\Yash\.gemini\antigravity\scratch\whatsapp-classroom-bot"

:: 2. Verify Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please install Node.js from https://nodejs.org and try again.
    echo.
    pause
    exit /b 1
)

:: 3. Check for credentials
if not exist "credentials.json" (
    color 0C
    echo [ERROR] credentials.json is missing in the project folder!
    echo.
    pause
    exit /b 1
)

:: 4. Start the bot.
::    Output is shown in this window AND appended to data\bot.log, so even a
::    silent crash leaves a full trace on disk that we can inspect later.
:startloop
echo [%date% %time%] ===== Bot starting =====>> "data\bot.log"
powershell -NoProfile -ExecutionPolicy Bypass -Command "npm start 2>&1 | Tee-Object -FilePath 'data\bot.log' -Append"
echo.
echo [%date% %time%] Bot stopped or crashed. Auto-restarting in 5 seconds.
echo [%date% %time%] Bot stopped or crashed. Auto-restarting in 5 seconds.>> "data\bot.log"
echo    Close this window to stop the bot permanently.
echo =============================================================================
timeout /t 5 /nobreak >nul
goto startloop
