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
rem Files are copied into folders under your user profile: no administrator rights, no
rem Developer Mode and no Node.js needed, and this folder can be deleted afterwards. The work
rem is done by scripts\install-assets.ps1 with the Windows PowerShell built into Windows.
setlocal
set "SELF=%~nx0"

rem -ExecutionPolicy Bypass applies to this one run only and changes no setting. A policy
rem set by the organisation (Group Policy) still wins; PowerShell then refuses and says why.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-assets.ps1" %*
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
