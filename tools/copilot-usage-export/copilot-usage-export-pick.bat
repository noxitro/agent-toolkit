@echo off
rem Same as copilot-usage-export.bat, but lists the sessions and asks which ones to export (numbers like 1,3,5 or 2-4) and in which format.
rem Arguments are passed through, e.g.: copilot-usage-export-pick.bat -Since 2026-10-01
rem (comments are ASCII on purpose: chcp inside a batch file breaks parsing of multibyte lines that follow it)
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0copilot-usage-export.ps1" -Pick %*
set RC=%ERRORLEVEL%
pause
exit /b %RC%
