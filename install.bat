@echo off
rem Install this toolkit's skills, commands and agents for Claude Code, OpenCode and
rem GitHub Copilot on this PC. Double-click it, or run it from a terminal with one of:
rem
rem   install.bat            install or update (the first run asks which tools to install for)
rem   install.bat --setup    choose the tools again
rem   install.bat --check    report what is installed, change nothing
rem   install.bat --remove   uninstall
rem   install.bat --link     developers: symlink to this folder instead of copying
rem                          (needs Developer Mode; `install.bat --copy` switches back)
rem
rem Files are copied into folders under your user profile; no administrator rights or
rem Developer Mode needed, and this folder can be deleted afterwards. The work is done by
rem scripts\install-assets.mjs, which only needs Node.js.
setlocal
set "SELF=%~nx0"
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 20 or later is required. Install it with:  winget install OpenJS.NodeJS.LTS
  echo Then open a new window and run this file again.
  goto :fail
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) < 20 ? 1 : 0)"
if errorlevel 1 (
  echo Node.js 20 or later is required. Update it with:  winget upgrade OpenJS.NodeJS.LTS
  goto :fail
)

rem Symlinks need Developer Mode or an elevated prompt; only --link creates them.
set "LINK="
for %%a in (%*) do if /i "%%~a"=="--link" set "LINK=1"
if not defined LINK goto :run
net session >nul 2>&1
if not errorlevel 1 goto :run
reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock" /v AllowDevelopmentWithoutDevLicense 2>nul | find "0x1" >nul
if errorlevel 1 (
  echo --link creates symlinks, which needs Windows Developer Mode.
  echo Opening Settings: turn on Developer Mode and run this again, or install without --link.
  start "" ms-settings:developers
  goto :fail
)

:run
node scripts\install-assets.mjs %*
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
