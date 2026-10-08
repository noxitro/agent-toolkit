@echo off
rem Builds Agent Builder skill zips from the skills adopted with "scout.mjs adopt"
rem (double-click to run). Reads <repo>\artifacts\skill-scout\overlays.json and writes
rem packages\ and zips\ next to it. Refuses while any TODO is left in overlays.json.
chcp 65001 >nul
setlocal
cd /d "%~dp0..\.."
set SCOUT=m365-org-skills\scout\scout.mjs
set ZIPS=%CD%\artifacts\skill-scout\zips

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js が見つかりません。Node 20 以上を入れてから、もう一度実行してください。
  goto :end
)

node "%SCOUT%" build
if errorlevel 1 goto :failed

start "" "%ZIPS%"
goto :end

:failed
echo.
echo ZIP を作れませんでした。上のメッセージを確認してください。

:end
echo.
pause
