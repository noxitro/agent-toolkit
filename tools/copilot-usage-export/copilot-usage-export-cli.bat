@echo off
rem Same as copilot-usage-export.bat, but writes per-session records in the GitHub Copilot CLI /share file format (output\cli\).
rem Arguments are passed through, e.g.: copilot-usage-export-cli.bat -Since 2026-10-19
rem (comments are ASCII on purpose: chcp inside a batch file breaks parsing of multibyte lines that follow it)
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0copilot-usage-export.ps1" -Format cli %*
set RC=%ERRORLEVEL%
pause
exit /b %RC%
