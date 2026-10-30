@echo off
title Switch the WhatsApp number for the Classroom Bot
color 0B

echo ================================================================
echo    Switch WhatsApp number - Classroom Bot
echo    This STOPS the current bot session, unlinks the old phone
echo    where possible, and shows a QR for the NEW phone to scan.
echo    Nothing is deleted - old sessions are archived by name.
echo ================================================================
echo.

:: 1. Work from the bot project directory
cd /d "C:\Users\Yash\.gemini\antigravity\scratch\whatsapp-classroom-bot"

:: 2. Verify Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Node.js is not installed or not in PATH!
    echo.
    pause
    exit /b 1
)

:: 3. Stop any running bot first (clear ghosts holding the lock port)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :48591 ^| findstr LISTENING') do (
    echo [INFO] Stopping current bot session PID %%a ...
    taskkill /f /pid %%a >nul 2>nul
)
timeout /t 2 /nobreak >nul

:: 4. Best-effort log out of the ORIGINAL session (only works while it is alive)
echo [%date% %time%] Logging out the old session ...
node pair.mjs logout
echo.

:: 5. Archive the old session folder so the pairing starts truly fresh.
::    (Everything is preserved - nothing is ever deleted.)
echo [%date% %time%] Archiving the old session folder ...
if exist "auth_info_baileys" powershell -NoProfile -Command "Rename-Item 'auth_info_baileys' ('auth_info_baileys_num_switch_' + (Get-Date -f yyyyMMdd-HHmmss))"

:: 6. Show the QR for the new phone and save its session
echo [%date% %time%] Waiting for the NEW phone to scan ...
node pair.mjs qr
echo.
echo ================================================================
echo    Next step: start the bot again with Start-Classroom-Bot.bat.
echo    Tip: set OWNER_NUMBER in the .env file to the new phone
echo    number if that phone is the new owner for admin commands.
echo ================================================================
pause
