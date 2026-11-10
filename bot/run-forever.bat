@echo off
rem LicenseManagerTGG keep-alive runner: restarts the bot if it crashes.
cd /d "%~dp0"
:loop
node index.js >> bot-forever.log 2>&1
echo [%date% %time%] bot exited, restarting in 5s >> bot-forever.log
timeout /t 5 /nobreak >nul
goto loop
