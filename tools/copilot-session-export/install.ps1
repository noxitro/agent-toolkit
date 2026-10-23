# copilot-session-export プラグインのための機能フラグを、いまのユーザーの Copilot に設定する / 外す / 状態を見る(管理者権限は要らない)。
#   install.ps1 enable    settings.json の feature_flags.enabled に EXTENSIONS を足す。前の版が拡張を直接置いた
#                         extensions\session-export が残っていれば消す(プラグインと二重に読まれないように)
#   install.ps1 status    機能フラグ・プラグイン・前の版の置き場の状態を見る
#   install.ps1 disable   enable が足した EXTENSIONS を外す
# 引数なしならメニューを出す。Copilot のホームは COPILOT_HOME、無ければ %USERPROFILE%\.copilot。UTF-8 (BOM 付き) で保存する。
#
# プラグイン本体は、アプリの Customize → Plugins(または copilot plugin install)でマーケットプレイスから入れる。
# 拡張は Copilot の実験的機能で、プラグインで入れても、機能フラグ EXTENSIONS が有効なときだけ読み込まれる。
# ここでは feature_flags.enabled に EXTENSIONS だけを足す(実験的機能をまとめて有効にする experimental: true は使わない)。
param([string]$Action)

$ErrorActionPreference = 'Stop'
$copilotHome = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $env:USERPROFILE '.copilot' }
$oldCopy = Join-Path $copilotHome 'extensions\session-export'
$settings = Join-Path $copilotHome 'settings.json'
$pluginId = 'copilot-session-export@agent-toolkit'
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
  $flag = @($s.feature_flags.enabled) -contains 'EXTENSIONS'
  $exp = $s.experimental -eq $true
  $env_ = $env:COPILOT_CLI_ENABLED_FEATURE_FLAGS -match '(^|,)\s*EXTENSIONS\s*(,|$)'
  $plugin = $false
  if ($s.enabledPlugins) { $p = $s.enabledPlugins.PSObject.Properties[$pluginId]; $plugin = $p -and $p.Value -eq $true }
  return @{ settings = $s; flag = $flag; experimental = $exp; envFlag = $env_; on = ($flag -or $exp -or $env_); plugin = $plugin }
}
function Remove-OldCopy {
  if (Test-Path $oldCopy) { Remove-Item $oldCopy -Recurse -Force; Write-Host "前の版の置き場を消した: $oldCopy(プラグインと二重に読まれないように)" }
}
function Enable-Flag {
  $st = Get-State
  if ($st.on) { Write-Host '機能フラグ EXTENSIONS はすでに有効(feature_flags・experimental・環境変数のどれか)。settings.json は変えない。' }
  else {
    $s = $st.settings
    if (-not $s.feature_flags) { $s | Add-Member -NotePropertyName feature_flags -NotePropertyValue (New-Object PSObject) }
    $enabled = @($s.feature_flags.enabled | Where-Object { $_ }) + 'EXTENSIONS'
    $s.feature_flags | Add-Member -NotePropertyName enabled -NotePropertyValue $enabled -Force
    Write-Settings $s
    Write-Host "有効にした: $settings の feature_flags.enabled に EXTENSIONS を足した(元の内容は settings.json.bak)。"
  }
  Remove-OldCopy
  if (-not (Get-State).plugin) {
    Write-Host 'プラグインはまだ入っていない。アプリの Customize → Plugins で、マーケットプレイス noxitro/agent-toolkit を足し、copilot-session-export を Install する(README の手順)。'
  }
  Write-Host 'デスクトップ アプリはアプリを再起動してから使える(Copilot CLI は次に起動したセッションから)。'
}
function Disable-Flag {
  $st = Get-State
  if (-not $st.flag) { Write-Host 'settings.json の feature_flags.enabled に EXTENSIONS は無い。'; return }
  $s = $st.settings
  $rest = @($s.feature_flags.enabled | Where-Object { $_ -and $_ -ne 'EXTENSIONS' })
  if ($rest.Count) { $s.feature_flags | Add-Member -NotePropertyName enabled -NotePropertyValue $rest -Force }
  else { $s.feature_flags.PSObject.Properties.Remove('enabled') }
  if (-not @($s.feature_flags.PSObject.Properties).Count) { $s.PSObject.Properties.Remove('feature_flags') }
  Write-Settings $s
  Write-Host 'settings.json の feature_flags.enabled から EXTENSIONS を外した(元の内容は settings.json.bak)。ほかの拡張も読み込まれなくなる。'
  Write-Host 'プラグインそのものは、アプリの Customize → Plugins(または copilot plugin uninstall)で外す。'
}
function Status {
  $st = Get-State
  if ($st.flag) { Write-Host '機能フラグ: 有効(settings.json の feature_flags.enabled に EXTENSIONS)' }
  elseif ($st.experimental) { Write-Host '機能フラグ: 有効(settings.json の experimental が true。実験的機能がまとめて有効)' }
  elseif ($st.envFlag) { Write-Host '機能フラグ: 有効(環境変数 COPILOT_CLI_ENABLED_FEATURE_FLAGS)' }
  else { Write-Host '機能フラグ: 無効。1 を選ぶと有効にする。' }
  if ($st.plugin) { Write-Host "プラグイン: 入っている($pluginId)" } else { Write-Host "プラグイン: 入っていない($pluginId)" }
  if (Test-Path $oldCopy) { Write-Host "前の版の置き場: 残っている($oldCopy)。1 を選ぶと消す。" }
}

if (-not $Action) {
  Write-Host '1) 機能フラグを有効にする  2) 状態を見る  3) 機能フラグを外す'
  $Action = @{ '1' = 'enable'; '2' = 'status'; '3' = 'disable' }[(Read-Host '番号')]
}
switch ($Action) {
  { $_ -in 'enable', 'install' } { Enable-Flag }
  'status' { Status }
  { $_ -in 'disable', 'uninstall' } { Disable-Flag }
  default { Write-Host '1〜3 のどれかを選ぶ。' }
}
