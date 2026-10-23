@echo off
rem Enable / check / disable the EXTENSIONS feature flag that the copilot-session-export plugin needs (current user, no admin). Double-click = menu.
rem The plugin itself is installed from the agent-toolkit marketplace (GitHub Copilot app: Customize > Plugins). See README.md.
rem Arguments are passed through, e.g.: install.bat enable
rem (comments are ASCII on purpose: chcp inside a batch file breaks parsing of multibyte lines that follow it)
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set RC=%ERRORLEVEL%
pause
exit /b %RC%
