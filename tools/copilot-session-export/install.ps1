# /export と /save-session の拡張を、いまのユーザーの Copilot に入れる / 外す / 状態を見る(管理者権限は要らない)。
#   install.ps1 install     session-export を <Copilot のホーム>\extensions\session-export へ写し(上書き)、拡張の機能フラグを有効にする
#   install.ps1 uninstall   そのフォルダを消し、install が足した機能フラグを外す
#   install.ps1 status      入っているか、拡張が有効になっているかを見る
# 引数なしならメニューを出す。Copilot のホームは COPILOT_HOME、無ければ %USERPROFILE%\.copilot。UTF-8 (BOM 付き) で保存する。
#
# 拡張は Copilot CLI の実験的機能で、機能フラグ EXTENSIONS が有効なときだけ読み込まれる。
# install は settings.json の feature_flags.enabled に EXTENSIONS を足す(実験的機能をまとめて有効にする experimental: true は使わない)。
param([string]$Action)

$ErrorActionPreference = 'Stop'
$copilotHome = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $env:USERPROFILE '.copilot' }
$src = Join-Path $PSScriptRoot 'session-export'
$dst = Join-Path $copilotHome 'extensions\session-export'
$settings = Join-Path $copilotHome 'settings.json'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Read-Settings {
  if (-not (Test-Path $settings)) { return New-Object PSObject }
  $text = [IO.File]::ReadAllText($settings, $utf8)
  if (-not $text.Trim()) { return New-Object PSObject }
  try { return $text | ConvertFrom-Json }
  catch { throw "settings.json を JSON として読めない($settings)。手で feature_flags.enabled に EXTENSIONS を足す: $($_.Exception.Message)" }
}
function Write-Settings($obj) {
  if (Test-Path $settings) { Copy-Item $settings "$settings.bak" -Force }
  [IO.File]::WriteAllText($settings, ($obj | ConvertTo-Json -Depth 20), $utf8)
}
function Get-State {
  $s = Read-Settings
  $flags = @($s.feature_flags.enabled) -contains 'EXTENSIONS'
  $exp = $s.experimental -eq $true
  return @{ settings = $s; flag = $flags; experimental = $exp; on = ($flags -or $exp -or ($env:COPILOT_CLI_ENABLED_FEATURE_FLAGS -match '(^|,)\s*EXTENSIONS\s*(,|$)')) }
}
function Enable-Flag {
  $st = Get-State
  if ($st.on) { Write-Host '拡張はすでに有効(機能フラグ・experimental・環境変数のどれか)。settings.json は変えない。'; return }
  $s = $st.settings
  if (-not $s.feature_flags) { $s | Add-Member -NotePropertyName feature_flags -NotePropertyValue (New-Object PSObject) }
  $enabled = @($s.feature_flags.enabled | Where-Object { $_ }) + 'EXTENSIONS'
  $s.feature_flags | Add-Member -NotePropertyName enabled -NotePropertyValue $enabled -Force
  Write-Settings $s
  Write-Host "有効にした: $settings の feature_flags.enabled に EXTENSIONS を足した(元の内容は settings.json.bak)。"
}
function Disable-Flag {
  $st = Get-State
  if (-not $st.flag) { return }
  $s = $st.settings
  $rest = @($s.feature_flags.enabled | Where-Object { $_ -and $_ -ne 'EXTENSIONS' })
  if ($rest.Count) { $s.feature_flags | Add-Member -NotePropertyName enabled -NotePropertyValue $rest -Force }
  else { $s.feature_flags.PSObject.Properties.Remove('enabled') }
  if (-not @($s.feature_flags.PSObject.Properties).Count) { $s.PSObject.Properties.Remove('feature_flags') }
  Write-Settings $s
  Write-Host "settings.json の feature_flags.enabled から EXTENSIONS を外した(元の内容は settings.json.bak)。"
}
function Install {
  New-Item -ItemType Directory -Force $dst | Out-Null
  Copy-Item (Join-Path $src '*.mjs') $dst -Force
  Write-Host "入れた: $dst"
  Enable-Flag
  Write-Host 'デスクトップ アプリはアプリを再起動してから /export と /save-session が使える(Copilot CLI では次に起動したセッションから。CLI の /export は組み込みのものが優先される)。'
}
function Uninstall {
  if (Test-Path $dst) { Remove-Item $dst -Recurse -Force; Write-Host "消した: $dst" }
  else { Write-Host '拡張のフォルダは無い。' }
  Disable-Flag
  Write-Host 'ほかの拡張を使っていて機能フラグを残したい場合は、settings.json.bak から戻す。'
}
function Status {
  if (Test-Path (Join-Path $dst 'extension.mjs')) { Write-Host "入っている: $dst" } else { Write-Host '入っていない。' }
  $st = Get-State
  if ($st.flag) { Write-Host '拡張: 有効(settings.json の feature_flags.enabled に EXTENSIONS)' }
  elseif ($st.experimental) { Write-Host '拡張: 有効(settings.json の experimental が true。実験的機能がまとめて有効)' }
  elseif ($st.on) { Write-Host '拡張: 有効(環境変数 COPILOT_CLI_ENABLED_FEATURE_FLAGS)' }
  else { Write-Host '拡張: 無効。install を実行すると有効にする。' }
}

if (-not $Action) {
  Write-Host '1) 入れる(上書き)  2) 状態を見る  3) 外す'
  $Action = @{ '1' = 'install'; '2' = 'status'; '3' = 'uninstall' }[(Read-Host '番号')]
}
switch ($Action) {
  'install' { Install }
  'status' { Status }
  'uninstall' { Uninstall }
  default { Write-Host '1〜3 のどれかを選ぶ。' }
}
