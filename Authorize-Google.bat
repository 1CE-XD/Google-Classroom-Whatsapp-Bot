@echo off
title Google Authorization for Classroom Bot
color 0B

echo ================================================================
echo    Google Account Authorization - Classroom Bot
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

echo This window runs the authorization flow. A URL will appear - copy it
echo into your browser, sign in with YOUR account, approve access ^(if
echo Google shows 'unverified app', click: Advanced - Go to ... unsafe^),
echo then copy the browser URL ^(code=...^) back into this window.
echo.
echo Bot restart is NOT needed afterwards - it picks up the fresh token
echo automatically on the next 10-minute auto-sync tick.
echo.
echo ----------------------------------------------------------------
echo.
npm run auth
echo.
echo ================================================================
echo You can close this window now.
echo ================================================================
pause
