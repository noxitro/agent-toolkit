# copilot-usage-export を毎日自動で動かす(Windows のタスク スケジューラ。いまのユーザーで登録し、管理者権限は要らない)。
#   copilot-usage-export-schedule.ps1 register [-At HH:mm]   毎日 At に実行する(省略すると時刻を聞く)(PC が止まっていたら、次に起動したときに実行)
#   copilot-usage-export-schedule.ps1 status                  登録の有無と前回の結果
#   copilot-usage-export-schedule.ps1 unregister              登録を消す
# 引数なしならメニューを出す。実行の結果は output\copilot-usage-export.log。UTF-8 (BOM 付き) で保存する。
param([string]$Action, [string]$At = '', [string]$TaskName = 'Copilot usage export')

$ErrorActionPreference = 'Stop'
$ps1 = Join-Path $PSScriptRoot 'copilot-usage-export.ps1'

function Register {
  if (-not $At) { $script:At = Read-Host '毎日実行する時刻(HH:mm)'; $At = $script:At }
  if ($At -notmatch '^\d{1,2}:\d{2}$') { Write-Host "-At は HH:mm で指定する: $At"; exit 1 }
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Quiet' -f $ps1)
  $trigger = New-ScheduledTaskTrigger -Daily -At $At
  $set = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $set -Description 'Copilot の使用量とセッションの記録を書き出す(copilot-usage-export)' -Force | Out-Null
  Write-Host "登録した: 毎日 $At に「$TaskName」を実行する。"
  Write-Host '止めるときは、このバッチで 3 を選ぶ。'
}
function Status {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $t) { Write-Host '登録されていない。'; return }
  $i = Get-ScheduledTaskInfo -TaskName $TaskName
  Write-Host ("登録あり: {0} / 次回 {1} / 前回 {2}(結果コード {3}。0 = 成功)" -f $TaskName, $i.NextRunTime, $i.LastRunTime, $i.LastTaskResult)
}
function Unregister {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; Write-Host "消した: $TaskName" }
  else { Write-Host '登録されていない。' }
}

if (-not $Action) {
  Write-Host '1) 毎日の自動実行を登録する  2) 状態を見る  3) 登録を消す'
  $Action = @{ '1' = 'register'; '2' = 'status'; '3' = 'unregister' }[(Read-Host '番号')]
}
switch ($Action) {
  'register' { Register }
  'status' { Status }
  'unregister' { Unregister }
  default { Write-Host '1〜3 のどれかを選ぶ。' }
}
