@echo off
rem Builds the Agent Builder skill zips into <repo>\artifacts\m365-org-zips (double-click to run).
rem Lineup: the dev assistant (minutes + 6 imported public skills) and the skill lab
rem (probe, minutes, and the public meeting-minutes for comparison).
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
set OUT=artifacts\m365-org-zips
set PACK=shared\skills\m365-skill-pack\scripts\pack-skill.mjs
set S=m365-org-skills\skills
set T=m365-org-skills\third-party

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js が見つかりません。Node 20 以上を入れてから、もう一度実行してください。
  goto :end
)

if exist "%OUT%" rmdir /s /q "%OUT%"

rem Our own skills: SKILL.template.md plus the shared common\ scripts
node "%PACK%" "%S%\minutes" --from-template --out "%OUT%"
if errorlevel 1 goto :failed

rem Imported public skills: SKILL.md as assembled by scout\import-upstream.mjs
node "%PACK%" "%T%\incident-postmortem" "%T%\root-cause-analysis" "%T%\create-architectural-decision-record" "%T%\create-specification" "%T%\prd" "%T%\sql-code-review" "%T%\meeting-minutes" --out "%OUT%"
if errorlevel 1 goto :failed

rem Environment probe for the skill lab agent
node "%PACK%" shared\skills\m365-skill-pack\m365\skills\probe --from-template --out "%OUT%"
if errorlevel 1 goto :failed

echo.
echo できあがった ZIP: %CD%\%OUT%
goto :end

:failed
echo.
echo ZIP の作成に失敗しました。上のメッセージを確認してください。

:end
echo.
pause
