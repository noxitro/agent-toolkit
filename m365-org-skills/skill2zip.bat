@echo off
rem Converts one skill (a folder with SKILL.md, a GitHub folder URL, or an installed skill name)
rem into a Microsoft 365 Copilot (Agent Builder) skill zip. Double-click and type the path or
rem URL, or drag a skill folder onto this file. Writes <repo>\artifacts\m365-zips\ and opens
rem the Japanese report. Extra options after the first argument are passed through
rem (for example: skill2zip.bat <url> --draft). Nothing from the skill is executed.
rem The report opened is the one named on the converter's last line ("REPORT: <path>"),
rem and only when the converter wrote one (exit code 0 or 1).
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
set CONVERT=shared\skills\m365-skill-convert\scripts\skill2zip.mjs
set OUT=%CD%\artifacts\m365-zips

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js が見つかりません。Node 20 以上を入れてから、もう一度実行してください。
  goto :end
)

set "IN=%~1"
if not "%IN%"=="" goto :run
echo 変換するスキルを指定します。次のどれかを入力して Enter を押してください。
echo   - スキルのフォルダのパス(直下に SKILL.md があるもの。フォルダをこの画面にドラッグしてもよい)
echo   - GitHub のフォルダの URL(https://github.com/^<owner^>/^<repo^>/tree/^<ブランチ^>/^<パス^>)
echo   - インストール済みのスキルの名前
set /p "IN=> "
rem Just Enter leaves IN undefined; stripping quotes from an undefined variable would
rem leave junk in it, so stop before that.
if not defined IN goto :end
set "IN=%IN:"=%"
if not defined IN goto :end

:run
rem Pass through any options given after the first argument.
set REST=
shift
:collect
if "%~1"=="" goto :convert
set REST=%REST% %1
shift
goto :collect

:convert
echo.
rem The output goes through a log file so the report path can be read from its last line.
set "LOG=%TEMP%\skill2zip-%RANDOM%%RANDOM%.log"
node "%CONVERT%" "%IN%" --out "%OUT%" %REST% > "%LOG%" 2>&1
set CODE=%ERRORLEVEL%
type "%LOG%"
set "REPORT="
for /f "usebackq tokens=1,* delims= " %%A in (`findstr /b /c:"REPORT: " "%LOG%"`) do set "REPORT=%%B"
del "%LOG%" >nul 2>nul
if not "%CODE%"=="0" if not "%CODE%"=="1" goto :failed
rem Exit code 1 without a report line is a crash, not a stopped conversion.
if not defined REPORT goto :failed
if defined REPORT if exist "%REPORT%" start "" "%REPORT%"
echo.
if "%CODE%"=="0" (
  echo ZIP は %OUT% にあります。Agent Builder に追加する前に、レポートと中身を全文読んでください。
) else (
  echo ZIP は作っていません。理由はレポートの「止めた理由」にあります。
  echo 読み替えの TODO が理由なら、%OUT% の ^<名前^>.overlay.json を書き換えてから、もう一度実行します。
)
goto :end

:failed
echo.
echo 変換できませんでした。上のメッセージを確認してください。

:end
echo.
pause
