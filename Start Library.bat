@echo off
title St Columban's Library
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install it from https://nodejs.org and try again.
  pause
  exit /b
)
if not exist node_modules (
  echo First-time setup. Please wait...
  call npm install
)
echo.
echo The library is starting. Keep this window open while the library is in use.
echo Close this window to stop it.
echo.
start "" /min cmd /c "timeout /t 3 >nul & start http://localhost:3000"
node server.js
pause
