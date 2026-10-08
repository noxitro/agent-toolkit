@echo off
rem Fetches the public skill repositories listed in sources.json and pre-screens every skill
rem (double-click to run). Writes <repo>\artifacts\skill-scout\report.md and opens it.
rem Keywords for the relevance column can be passed as arguments: scout-scan.bat meeting review
rem Nothing from the fetched repositories is executed.
chcp 65001 >nul
setlocal
cd /d "%~dp0..\.."
set SCOUT=m365-org-skills\scout\scout.mjs
set REPORT=%CD%\artifacts\skill-scout\report.md

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js が見つかりません。Node 20 以上を入れてから、もう一度実行してください。
  goto :end
)
where git >nul 2>nul
if errorlevel 1 (
  echo Git が見つかりません。Git for Windows を入れてから、もう一度実行してください。
  goto :end
)

node "%SCOUT%" fetch
if errorlevel 1 (
  echo.
  echo 一部のリポジトリを取得できませんでした。取得済みのものだけをチェックします。
)

echo.
if "%~1"=="" (
  node "%SCOUT%" scan
) else (
  node "%SCOUT%" scan --keyword "%*"
)
if errorlevel 1 goto :failed

start "" "%REPORT%"
echo.
echo 採用するものが決まったら、コマンド プロンプトで次を実行します(名前は report.md のもの):
echo   node %SCOUT% adopt ^<名前^>
echo そのあと artifacts\skill-scout\overlays.json の TODO を書き換えて、scout-build.bat を実行します。
goto :end

:failed
echo.
echo チェックに失敗しました。上のメッセージを確認してください。

:end
echo.
pause
