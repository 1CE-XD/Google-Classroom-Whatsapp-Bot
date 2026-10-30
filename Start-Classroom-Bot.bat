@echo off
title WhatsApp Google Classroom ^& AI Study Assistant
color 0A

echo ================================================================
echo    WhatsApp Google Classroom ^& AI Study Assistant
echo    Auto-restart is ON: if the bot crashes, it relaunches.
echo    All console output is ALSO logged to data\bot.log,
echo    so silent crashes leave a trace on disk.
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
    echo [ERROR] credentials.json is missing in project folder!
    echo.
    pause
    exit /b 1
)

:: 4. Automatically clear any old ghost bot holding port 48591
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :48591 ^| findstr LISTENING') do (
    echo [INFO] Closing previous bot session (PID: %%a)...
    taskkill /f /pid %%a >nul 2>nul
)

:: 5. Launch the bot through tee.mjs: console output AND data\bot.log at once
:startloop
echo [%date% %time%] Starting bot...
:: NOTE: node can stay silent for up to 1-2 minutes on cold start while
:: loading modules (no banner yet = still booting, not frozen).
node tee.mjs src/index.js
echo.
echo [%date% %time%] Bot stopped. Restarting in 3 seconds...
echo (Close this window to stop the bot permanently)
echo ================================================================
timeout /t 3 /nobreak >nul
goto startloop
