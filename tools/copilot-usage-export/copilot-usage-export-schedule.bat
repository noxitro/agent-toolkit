@echo off
rem Register / check / remove the daily run of copilot-usage-export (Windows Task Scheduler, current user, no admin). Double-click = menu.
rem Arguments are passed through, e.g.: copilot-usage-export-schedule.bat register -At 12:00
rem (comments are ASCII on purpose: chcp inside a batch file breaks parsing of multibyte lines that follow it)
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0copilot-usage-export-schedule.ps1" %*
set RC=%ERRORLEVEL%
pause
exit /b %RC%
