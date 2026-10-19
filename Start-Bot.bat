@echo off
title WhatsApp Google Classroom & AI Study Assistant
color 0A

echo ================================================================
echo    WhatsApp Google Classroom & AI Study Assistant Launcher
echo ================================================================
echo.

cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please install Node.js from https://nodejs.org and try again.
    echo.
    pause
    exit /b 1
)

if not exist "credentials.json" (
    color 0C
    echo [ERROR] credentials.json is missing!
    echo.
    pause
    exit /b 1
)

echo [*] Starting bot...
echo.
npm start

echo.
echo Bot stopped.
pause
