@echo off
rem Install / check / remove the /save-session extension for GitHub Copilot (current user, no admin). Double-click = menu.
rem Arguments are passed through, e.g.: install.bat install
rem (comments are ASCII on purpose: chcp inside a batch file breaks parsing of multibyte lines that follow it)
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set RC=%ERRORLEVEL%
pause
exit /b %RC%
