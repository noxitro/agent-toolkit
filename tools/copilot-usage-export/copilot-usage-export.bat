@echo off
rem Export GitHub Copilot usage and per-session records from this PC. Double-click = last 7 days. No model calls, no credits used.
rem Arguments are passed through, e.g.: copilot-usage-export.bat -Since 2026-10-19 -ToolOutput all
rem (comments are ASCII on purpose: chcp inside a batch file breaks parsing of multibyte lines that follow it)
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0copilot-usage-export.ps1" %*
set RC=%ERRORLEVEL%
pause
exit /b %RC%
