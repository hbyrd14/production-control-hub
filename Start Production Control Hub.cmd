@echo off
rem Double-click to start Production Control Hub. Close this window (or press Ctrl+C) to stop it.
title Production Control Hub
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and try again.
  goto end
)

if not exist "apps\gateway\dist\index.js" goto needbuild
if not exist "apps\web\dist\index.html" goto needbuild
goto run

:needbuild
echo PCH has not been built yet. Running "Update Production Control Hub" first...
call "%~dp0Update Production Control Hub.cmd" /nopause
if errorlevel 1 goto end

:run
rem Listen on the network so iPads can connect, unless .env sets PCH_HOST.
findstr /b /c:"PCH_HOST=" ".env" >nul 2>nul
if errorlevel 1 set "PCH_HOST=0.0.0.0"

echo Starting Production Control Hub. Keep this window open during the show.
echo Close this window to stop PCH.
echo.
node --disable-warning=ExperimentalWarning "apps\gateway\dist\index.js"

:end
echo.
echo Production Control Hub has stopped. Press any key to close this window.
pause >nul
