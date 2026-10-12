@echo off
rem doc-context-build: collect -> bundle -> compose を順に実行する。
rem 使い方: build-context.bat <プロジェクトのフォルダー(docctx.json がある場所)>
rem トークンは環境変数 DOC_SITE_TOKEN(docctx.json の token_env)に入れておく。
setlocal
if "%~1"=="" (
  echo 使い方: %~nx0 ^<プロジェクトのフォルダー^>
  exit /b 2
)
set "HERE=%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo python が見つかりません。Python 3.8 以上を入れて PATH に通してください。
  exit /b 2
)
echo [1/3] 収集
python -I "%HERE%scripts\collect.py" "%~1" || goto :fail
echo [2/3] 束ね
python -I "%HERE%scripts\bundle.py" "%~1" || goto :fail
echo [3/3] 合成
python -I "%HERE%scripts\compose.py" "%~1" || goto :fail
echo 完了。out\context\ の中身を Microsoft 365 Copilot の執筆エージェントに添付してください。
exit /b 0
:fail
echo 失敗しました。上のメッセージを確認してください。
exit /b 1
