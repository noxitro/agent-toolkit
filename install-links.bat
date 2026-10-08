@echo off
rem Link this clone's generated skills, commands and agents into the per-user folders that
rem Claude Code, OpenCode and GitHub Copilot read, so every session picks up the output of
rem `npm run build` without copying or installing the plugin. Double-click it, or run it
rem from a terminal with one of:
rem
rem   install-links.bat            first run asks which harnesses to link; later runs repair links
rem   install-links.bat --setup    choose the harnesses again
rem   install-links.bat --check    report the state of every link, change nothing
rem   install-links.bat --remove   remove every link this clone created
rem
rem The work is done by scripts\install-links.mjs (same as `npm run links`); this file only
rem checks Node.js, Developer Mode and the npm dependencies first.
setlocal
set "SELF=%~nx0"
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 20 or later is required. Install it with:  winget install OpenJS.NodeJS.LTS
  goto :fail
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) < 20 ? 1 : 0)"
if errorlevel 1 (
  echo Node.js 20 or later is required. Update it with:  winget upgrade OpenJS.NodeJS.LTS
  goto :fail
)

rem Creating symlinks needs Developer Mode or an elevated prompt; checking and removing do not.
if /i "%~1"=="--check" goto :deps
if /i "%~1"=="--remove" goto :deps
net session >nul 2>&1
if not errorlevel 1 goto :deps
reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock" /v AllowDevelopmentWithoutDevLicense 2>nul | find "0x1" >nul
if errorlevel 1 (
  echo Creating symlinks needs Windows Developer Mode.
  echo Opening Settings: turn on Developer Mode, then run this file again.
  start "" ms-settings:developers
  goto :fail
)

:deps
if not exist "node_modules\yaml\" (
  echo Installing npm dependencies...
  call npm ci --no-audit --no-fund
  if errorlevel 1 goto :fail
)

node scripts\install-links.mjs %*
if errorlevel 1 goto :fail
call :pause_if_double_clicked
exit /b 0

:fail
call :pause_if_double_clicked
exit /b 1

rem Keep the window open when started from Explorer, so the output can be read.
:pause_if_double_clicked
echo %cmdcmdline% | find /i "%SELF%" >nul && pause
exit /b 0
