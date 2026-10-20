# Started by tests/windows-no-symlink/run.ps1 in a process that cannot create symlinks: both
# installers in link mode must fall back to junctions for folders and copies for files, with
# no AGENT_TOOLKIT_NO_SYMLINK set. Writes its findings to <work>\result.log and the number of
# failed checks to <work>\result.code, since the caller cannot read this process's output.

param([string]$work, [string]$repo, [string]$node)

$ErrorActionPreference = 'Continue'
$log = Join-Path $work 'result.log'
$script:failures = 0
function Say([string]$text) { Add-Content -LiteralPath $log -Value $text }
function Expect([bool]$ok, [string]$what) {
  if ($ok) { Say "  ok   $what" } else { Say "  FAIL $what"; $script:failures++ }
}
function Invoke-Installer($installer, [string[]]$argv) {
  $out = & $installer.cmd @($installer.pre + $argv) 2>&1 | Out-String
  Say ($out.TrimEnd() -replace '(?m)^', '       | ')
  return @{ code = $LASTEXITCODE; out = $out }
}

try {
  Say "user: $(whoami)"
  # Positive control: in a process that can make symlinks, this test would prove nothing.
  $probe = Join-Path $work 'probe-link'
  cmd.exe /c "mklink `"$probe`" nowhere >nul 2>&1"
  Expect ($LASTEXITCODE -ne 0) 'this process cannot create symlinks'

  $sources = @(Get-ChildItem -LiteralPath (Join-Path $repo 'plugins') -Recurse -File).Count
  $installers = @(
    @{ name = 'powershell'; cmd = 'powershell.exe'; pre = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $repo 'scripts\install-assets.ps1')) },
    @{ name = 'node'; cmd = $node; pre = @((Join-Path $repo 'scripts\install-assets.mjs')) }
  )
  Remove-Item Env:\AGENT_TOOLKIT_NO_SYMLINK -ErrorAction SilentlyContinue
  $env:AGENT_TOOLKIT_ROOT = $repo
  $env:TEMP = Join-Path $work 'tmp'
  $env:TMP = $env:TEMP
  New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
  Set-Location -LiteralPath $repo

  foreach ($i in $installers) {
    Say "--- $($i.name)"
    $userHome = Join-Path $work "home-$($i.name)"
    New-Item -ItemType Directory -Force -Path $userHome | Out-Null
    $env:USERPROFILE = $userHome
    $env:HOME = $userHome
    $env:APPDATA = Join-Path $userHome 'AppData\Roaming'

    $r = Invoke-Installer $i @('--setup', 'claude,opencode,copilot', '--link')
    Expect ($r.code -eq 0) 'install with --link exits 0'
    Expect ($r.out -match 'junctions') 'says it falls back to junctions'
    $skills = @(Get-ChildItem -LiteralPath (Join-Path $userHome '.claude\skills') -Force)
    Expect ($skills.Count -gt 0 -and @($skills | Where-Object { $_.LinkType -ne 'Junction' }).Count -eq 0) 'every skill folder is a junction'
    $files = @(Get-ChildItem -LiteralPath (Join-Path $userHome '.claude\commands'), (Join-Path $userHome '.claude\agents') -Force)
    Expect ($files.Count -gt 0 -and @($files | Where-Object { $_.LinkType }).Count -eq 0) 'every single file is a copy'
    Expect ((Invoke-Installer $i @('--check')).code -eq 0) '--check exits 0'
    Expect ((Invoke-Installer $i @('--remove')).code -eq 0) '--remove exits 0'
    Expect (@(Get-ChildItem -LiteralPath (Join-Path $userHome '.claude\skills') -Force).Count -eq 0) 'nothing is left in ~/.claude/skills'
    Expect (@(Get-ChildItem -LiteralPath (Join-Path $repo 'plugins') -Recurse -File).Count -eq $sources) 'the folders the junctions pointed at are intact'
  }
} catch {
  Say "  FAIL $($_.Exception.Message)"
  $script:failures++
}
Set-Content -LiteralPath (Join-Path $work 'result.code') -Value $script:failures
