# CI only (installer-windows job): run both installers in link mode on a Windows PC where
# symlinks really cannot be made, rather than pretending with AGENT_TOOLKIT_NO_SYMLINK.
#
# Hosted runners turn Developer Mode on and run as an administrator, so both are undone for
# one process: Developer Mode off in the registry (takes effect at once), and the installers
# started with `runas /trustlevel:0x20000`, whose token has the Administrators group deny-only
# and no SeCreateSymbolicLinkPrivilege. Measured on windows-latest (2026-10): with Developer
# Mode on, that process can still make symlinks; with it off, it cannot, but junctions work.
#
# It changes machine settings, so it refuses to run outside GitHub Actions.

param([string]$node = (Get-Command node).Source)

$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') {
  Write-Host 'This test turns off Developer Mode; it runs only on a GitHub Actions runner.'
  exit 2
}

$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$work = 'C:\agent-toolkit-no-symlink'
if (Test-Path $work) { Remove-Item -LiteralPath $work -Recurse -Force }
New-Item -ItemType Directory -Path $work | Out-Null
# The restricted token keeps the user but not the Administrators group.
icacls $work /grant 'Users:(OI)(CI)M' | Out-Null

$key = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock'
$before = (Get-ItemProperty -Path $key -Name AllowDevelopmentWithoutDevLicense -ErrorAction SilentlyContinue).AllowDevelopmentWithoutDevLicense
Set-ItemProperty -Path $key -Name AllowDevelopmentWithoutDevLicense -Value 0 -Type DWord
try {
  $inner = Join-Path $PSScriptRoot 'run-installers.ps1'
  # runas returns at once; the inner script reports through files in $work.
  runas /trustlevel:0x20000 "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$inner`" -work `"$work`" -repo `"$repo`" -node `"$node`""
  $codeFile = Join-Path $work 'result.code'
  for ($i = 0; $i -lt 300 -and -not (Test-Path $codeFile); $i++) { Start-Sleep -Seconds 1 }
  $logFile = Join-Path $work 'result.log'
  if (Test-Path $logFile) { Get-Content -LiteralPath $logFile }
  if (-not (Test-Path $codeFile)) {
    Write-Host 'The restricted process did not finish within 5 minutes.'
    exit 1
  }
  $failures = [int](Get-Content -LiteralPath $codeFile)
  Write-Host ''
  if ($failures) { Write-Host "$failures check(s) failed."; exit 1 }
  Write-Host 'Both installers fell back to junctions and copies without symlink rights.'
} finally {
  if ($null -eq $before) { Remove-ItemProperty -Path $key -Name AllowDevelopmentWithoutDevLicense -ErrorAction SilentlyContinue }
  else { Set-ItemProperty -Path $key -Name AllowDevelopmentWithoutDevLicense -Value $before -Type DWord }
}
