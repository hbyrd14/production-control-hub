@echo off
rem Double-click after unzipping a new PCH version (or the first time) to install and build it.
rem Your accounts, settings and profiles in the "data" folder are not touched.
title Update Production Control Hub
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and try again.
  goto fail
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo Installing pnpm...
  call npm install -g pnpm
  if errorlevel 1 goto fail
)

echo Installing dependencies...
call pnpm install
if errorlevel 1 goto fail
echo Building...
call pnpm build
if errorlevel 1 goto fail

echo.
echo Update complete. Start PCH with "Start Production Control Hub".
if /i not "%~1"=="/nopause" (pause & exit /b 0)
exit /b 0

:fail
echo.
echo Update failed. See the messages above.
if /i not "%~1"=="/nopause" pause
exit /b 1
