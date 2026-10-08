# Install this repository's generated skills, commands and agents into the per-user folders
# that Claude Code, OpenCode and GitHub Copilot read. The Windows installer: install.bat runs
# it with the Windows PowerShell 5.1 that every Windows 10/11 PC has, so nothing else (no
# Node.js) is needed. scripts/install-assets.mjs is the same installer for macOS / Linux and
# developers; both read scripts/install-presets.json and share one state file, so either can
# update or remove what the other installed. Keep their behaviour and messages in step
# (tests/install-assets.test.mjs runs the same scenarios against both).
#
#   install-assets.ps1                  install or update (the first run asks which tools)
#   install-assets.ps1 --setup [list]   choose the tools again (e.g. claude,copilot)
#   install-assets.ps1 --link           switch to symlinks into this folder (developers;
#                                       needs Developer Mode or an elevated prompt)
#   install-assets.ps1 --copy           switch back to copies (the default)
#   install-assets.ps1 --check          report state, exit 1 if anything needs attention
#   install-assets.ps1 --remove         uninstall everything this installer put in place
#   install-assets.ps1 --force          also overwrite files edited or placed by hand
#
# The mode, the tool selection and a content hash of every copy are kept in
# ~/.agent-toolkit/<package>.json. Files this installer did not put there, and copies edited
# since, are never overwritten or deleted without --force.
#
# This file must stay ASCII: Windows PowerShell 5.1 reads a script without a BOM in the
# system code page. It must also stay 5.1-compatible (no ?:, ??, && or -AsHashtable).

$ErrorActionPreference = 'Stop'
# Copy-Item draws a progress bar per copy in pwsh 7.4+, which flickers over the output.
$ProgressPreference = 'SilentlyContinue'

if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  Write-Host "PowerShell runs in $($ExecutionContext.SessionState.LanguageMode) mode on this PC (an organisation policy), which this installer cannot run in."
  Write-Host 'Ask your IT department, or copy the folders listed in README.md by hand.'
  exit 1
}

$argv = @($args | ForEach-Object { [string]$_ })
function Test-Flag([string]$name) {
  foreach ($a in $argv) {
    if ($a.StartsWith('-') -and $a.TrimStart('-').ToLowerInvariant() -eq $name) { return $true }
  }
  return $false
}
$check = Test-Flag 'check'
$remove = Test-Flag 'remove'
$force = Test-Flag 'force'
$setupFlag = Test-Flag 'setup'
$setupList = $null
for ($i = 0; $i -lt $argv.Count - 1; $i++) {
  if ($argv[$i] -match '^--?setup$' -and -not $argv[$i + 1].StartsWith('-')) { $setupList = $argv[$i + 1] }
}
if ((Test-Flag 'copy') -and (Test-Flag 'link')) {
  Write-Host 'Choose one of --copy and --link.'
  exit 1
}

$onWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
$sep = [IO.Path]::DirectorySeparatorChar

function Read-Json([string]$path) {
  if (-not [IO.File]::Exists($path)) { return $null }
  return ([IO.File]::ReadAllText($path) | ConvertFrom-Json)
}
function Get-Prop($obj, [string]$name) {
  if ($null -ne $obj -and $obj.PSObject.Properties[$name]) { return $obj.$name }
  return $null
}

if ($env:AGENT_TOOLKIT_ROOT) { $Root = [IO.Path]::GetFullPath($env:AGENT_TOOLKIT_ROOT) }
else { $Root = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..')) }
$config = Read-Json ([IO.Path]::Combine($Root, 'toolkit.config.json'))
$pkg = Read-Json ([IO.Path]::Combine($Root, 'package.json'))
$claudePlugin = Get-Prop $config 'claudePlugin'
if (-not $claudePlugin) { $claudePlugin = 'toolkit-core' }
$version = Get-Prop $pkg 'version'

# Same home folder as Node's os.homedir(): USERPROFILE on Windows, HOME elsewhere.
if ($onWindows) { $UserHome = $env:USERPROFILE } else { $UserHome = $env:HOME }
$UserHome = [IO.Path]::GetFullPath($UserHome)

function Get-Tilde([string]$p) {
  if ($p.StartsWith($UserHome, [StringComparison]::Ordinal)) { return '~' + $p.Substring($UserHome.Length) }
  return $p
}

# ---- presets (scripts/install-presets.json) ----

$table = (Read-Json ([IO.Path]::Combine($PSScriptRoot, 'install-presets.json'))).harnesses
$Harnesses = @($table.PSObject.Properties | ForEach-Object { $_.Name })

if ($env:XDG_CONFIG_HOME) { $xdgConfig = $env:XDG_CONFIG_HOME } else { $xdgConfig = [IO.Path]::Combine($UserHome, '.config') }
if ($onWindows) {
  if ($env:APPDATA) { $appData = $env:APPDATA } else { $appData = [IO.Path]::Combine($UserHome, 'AppData', 'Roaming') }
  $vscodeUser = [IO.Path]::Combine($appData, 'Code', 'User')
} elseif ($IsMacOS) {
  $vscodeUser = [IO.Path]::Combine($UserHome, 'Library', 'Application Support', 'Code', 'User')
} else {
  $vscodeUser = [IO.Path]::Combine($xdgConfig, 'Code', 'User')
}
$vars = @{ home = $UserHome; xdgConfig = $xdgConfig; vscodeUser = $vscodeUser; claudePlugin = $claudePlugin }

function Expand-Template([string]$template) {
  $parts = [string[]]@($template.Split('/') | ForEach-Object {
      [regex]::Replace($_, '\{(\w+)\}', { param($m) $vars[$m.Groups[1].Value] })
    })
  return [IO.Path]::Combine($parts)
}

function Get-SortedNames([string]$dir) {
  $names = [string[]]@([IO.Directory]::GetFileSystemEntries($dir) | ForEach-Object { [IO.Path]::GetFileName($_) })
  [Array]::Sort($names, [StringComparer]::Ordinal)
  return , $names
}

function Get-PresetEntries([string[]]$selected) {
  $out = New-Object System.Collections.Generic.List[object]
  foreach ($h in $selected) {
    foreach ($e in @($table.$h.entries)) {
      $skip = Get-Prop $e 'skipIfSelected'
      if ($skip -and ($selected -contains $skip)) { continue }
      $from = Expand-Template $e.from
      $abs = [IO.Path]::Combine($Root, $from)
      if (-not [IO.Directory]::Exists($abs)) { continue }
      foreach ($n in (Get-SortedNames $abs)) {
        if ($n.StartsWith('.')) { continue }
        $out.Add([pscustomobject]@{ path = [IO.Path]::Combine((Expand-Template $e.to), $n); target = [IO.Path]::Combine($from, $n) })
      }
    }
  }
  return $out
}

function Get-AllPresetDirs {
  $dirs = New-Object System.Collections.Generic.List[string]
  foreach ($h in $Harnesses) {
    foreach ($e in @($table.$h.entries)) {
      $d = Expand-Template $e.to
      if (-not $dirs.Contains($d)) { $dirs.Add($d) }
    }
  }
  return $dirs
}

# Case is folded only where the filesystem does (Windows).
function Get-Normal([string]$p) {
  if ($p.StartsWith('\\?\')) { $p = $p.Substring(4) }
  $r = [IO.Path]::GetFullPath($p).TrimEnd('\', '/')
  if ($onWindows) { $r = $r.Replace('/', '\').ToLowerInvariant() }
  return $r
}

function Test-Inside([string]$child, [string]$parent) {
  $c = Get-Normal $child
  $p = Get-Normal $parent
  return ($c -ceq $p) -or $c.StartsWith($p + $sep, [StringComparison]::Ordinal)
}

# Same bytes as treeHash() in scripts/lib/presets.mjs, so both installers read one state file.
function Add-HashBytes($sha, [byte[]]$bytes) { [void]$sha.TransformBlock($bytes, 0, $bytes.Length, $null, 0) }
function Add-TreeBytes($sha, [string]$abs, [string]$rel) {
  $utf8 = New-Object Text.UTF8Encoding $false
  if ([IO.File]::GetAttributes($abs) -band [IO.FileAttributes]::Directory) {
    Add-HashBytes $sha $utf8.GetBytes("d $rel`0")
    foreach ($n in (Get-SortedNames $abs)) {
      if ($rel) { $childRel = "$rel/$n" } else { $childRel = $n }
      Add-TreeBytes $sha ([IO.Path]::Combine($abs, $n)) $childRel
    }
  } else {
    Add-HashBytes $sha $utf8.GetBytes("f $rel`0")
    Add-HashBytes $sha ([IO.File]::ReadAllBytes($abs))
    Add-HashBytes $sha $utf8.GetBytes("`0")
  }
}
function Get-TreeHash([string]$path) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    Add-TreeBytes $sha $path ''
    [void]$sha.TransformFinalBlock((New-Object byte[] 0), 0, 0)
    return (($sha.Hash | ForEach-Object { $_.ToString('x2') }) -join '')
  } finally { $sha.Dispose() }
}

# ---- state (~/.agent-toolkit/<package>.json) ----

$pkgName = Get-Prop $pkg 'name'
if (-not $pkgName) { $pkgName = [IO.Path]::GetFileName($Root) }
$id = [regex]::Replace(($pkgName -replace '^@', ''), '[^a-zA-Z0-9._-]+', '-')
$StateFile = [IO.Path]::Combine($UserHome, '.agent-toolkit', "$id.json")
$saved = Read-Json $StateFile
$mode = 'copy'
$selected = @()
$copies = New-Object 'System.Collections.Generic.Dictionary[string,string]'
if ($saved) {
  if (Get-Prop $saved 'mode') { $mode = $saved.mode }
  $selected = @(Get-Prop $saved 'harnesses' | Where-Object { $_ })
  $c = Get-Prop $saved 'copies'
  if ($c) { foreach ($p in $c.PSObject.Properties) { $copies[$p.Name] = [string]$p.Value } }
}
if (Test-Flag 'copy') { $mode = 'copy' }
if (Test-Flag 'link') { $mode = 'link' }
$linkMode = $mode -eq 'link'

function Save-State {
  $c = [ordered]@{}
  foreach ($k in $copies.Keys) { $c[$k] = $copies[$k] }
  $obj = [ordered]@{ mode = $mode; harnesses = [string[]]@($selected); version = $version; source = $Root; copies = $c }
  [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($StateFile))
  [IO.File]::WriteAllText($StateFile, (ConvertTo-Json -InputObject $obj -Depth 5) + "`n", (New-Object Text.UTF8Encoding $false))
}

# Copies are recorded relative to the home folder ("~/.claude/skills/x", always with "/"), so
# both installers agree on the key however each spells the home folder (Windows PowerShell 5.1
# expands 8.3 short names such as RUNNER~1, Node does not). Looked up case-insensitively where
# the filesystem is.
function Get-RecordKey([string]$p) {
  if ($p.StartsWith($UserHome + $sep, [StringComparison]::Ordinal)) {
    return '~/' + $p.Substring($UserHome.Length + 1).Replace([string]$sep, '/')
  }
  return $p
}
function Get-RecordPath([string]$k) {
  if ($k.StartsWith('~/')) { return [IO.Path]::Combine($UserHome, $k.Substring(2).Replace('/', [string]$sep)) }
  return $k
}
function Find-RecordKey([string]$p) {
  $n = Get-Normal $p
  foreach ($k in @($copies.Keys)) { if ((Get-Normal (Get-RecordPath $k)) -ceq $n) { return $k } }
  return $null
}
function Set-Record([string]$p, [string]$hash) {
  Remove-Record $p
  $copies[(Get-RecordKey $p)] = $hash
}
function Get-Recorded([string]$p) {
  $k = Find-RecordKey $p
  if ($null -eq $k) { return $null }
  return $copies[$k]
}
function Remove-Record([string]$p) {
  $k = Find-RecordKey $p
  if ($null -ne $k) { [void]$copies.Remove($k) }
}

# ---- choosing harnesses ----

function ConvertTo-Harnesses([string]$text) {
  $picked = @($text -split '[\s,]+' | Where-Object { $_ } | ForEach-Object {
      $t = $_.ToLowerInvariant()
      $n = 0
      if ([int]::TryParse($t, [ref]$n) -and $n -ge 1 -and $n -le $Harnesses.Count) { $Harnesses[$n - 1] } else { $t }
    })
  $unknown = @($picked | Where-Object { $Harnesses -notcontains $_ })
  if ($unknown.Count) { throw "unknown harness: $($unknown -join ', ') (choose from $($Harnesses -join ', '))" }
  return @($Harnesses | Where-Object { $picked -contains $_ })
}

function Read-Harnesses {
  if ([Console]::IsInputRedirected) {
    Write-Host "No harnesses selected. Run with --setup <list>, e.g. --setup $($Harnesses -join ',')"
    exit 1
  }
  Write-Host 'Which tools should the assets be installed for?'
  for ($i = 0; $i -lt $Harnesses.Count; $i++) {
    $h = $Harnesses[$i]
    Write-Host ('  {0}) {1,-9} {2,-15} {3}' -f ($i + 1), $h, $table.$h.label, $table.$h.summary)
  }
  while ($true) {
    $answer = (Read-Host 'Numbers or names, comma-separated [1]').Trim()
    if (-not $answer) { $answer = '1' }
    try {
      $picked = @(ConvertTo-Harnesses $answer)
      if ($picked.Count) { return $picked }
    } catch { Write-Host "  $($_.Exception.Message)" }
  }
}

$local = Read-Json ([IO.Path]::Combine($Root, 'toolkit.local.json'))
$declared = @(@(Get-Prop $config 'links') + @(Get-Prop $local 'links') | Where-Object { $_ })

if ($setupFlag -or (-not $check -and -not $remove -and $selected.Count -eq 0 -and $declared.Count -eq 0 -and -not [Console]::IsInputRedirected)) {
  try {
    if ($setupList) { $selected = @(ConvertTo-Harnesses $setupList) } else { $selected = @(Read-Harnesses) }
  } catch {
    Write-Host $_.Exception.Message
    exit 1
  }
  Write-Host ''
}

function Resolve-Entry($path, $target) {
  if ($path.StartsWith('~')) { $path = [IO.Path]::Combine($UserHome, $path.Substring(1).TrimStart('/', '\')) }
  $dest = [IO.Path]::GetFullPath($path)
  if ([IO.Path]::IsPathRooted($target)) { $src = [IO.Path]::GetFullPath($target) }
  else { $src = [IO.Path]::GetFullPath([IO.Path]::Combine($Root, $target)) }
  return [pscustomobject]@{ dest = $dest; src = $src; label = (Get-Tilde $dest) }
}
$entries = @(@($declared) + @(Get-PresetEntries $selected) | Where-Object { $_ } | ForEach-Object { Resolve-Entry $_.path $_.target })
$keep = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($e in $entries) { [void]$keep.Add((Get-Normal $e.dest)) }

# ---- inspecting and changing what is installed ----

function Get-ItemOrNull([string]$p) {
  try { return Get-Item -LiteralPath $p -Force -ErrorAction Stop } catch { return $null }
}
function Test-Link($item) { return $null -ne $item -and $item.LinkType -eq 'SymbolicLink' }
function Get-LinkTo($item) {
  $t = [string]@($item.Target)[0]
  if ($t.StartsWith('\\?\')) { $t = $t.Substring(4) }
  return $t
}

# What is at $dest now, from this installer's point of view.
function Get-State([string]$dest) {
  $item = Get-ItemOrNull $dest
  if ($null -eq $item) { return @{ kind = 'missing' } }
  if (Test-Link $item) { return @{ kind = 'link'; to = (Get-LinkTo $item) } }
  $hash = Get-Recorded $dest
  if ($null -eq $hash) { return @{ kind = 'foreign'; dir = $item.PSIsContainer } }
  if ((Get-TreeHash $dest) -eq $hash) { return @{ kind = 'copy'; dir = $item.PSIsContainer } }
  return @{ kind = 'edited'; dir = $item.PSIsContainer }
}

function Remove-Installed([string]$p) {
  $item = Get-ItemOrNull $p
  if ($null -ne $item) {
    if (Test-Link $item) {
      # Delete the link only; Remove-Item -Recurse on a link can empty its target in 5.1.
      if ($onWindows -and $item.PSIsContainer) { [IO.Directory]::Delete($p, $false) } else { [IO.File]::Delete($p) }
    } elseif ($item.PSIsContainer) {
      Remove-Item -LiteralPath $p -Recurse -Force
    } else {
      Remove-Item -LiteralPath $p -Force
    }
  }
  Remove-Record $p
}

function New-Installed([string]$src, [string]$dest) {
  [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($dest))
  if ($linkMode) {
    if ($onWindows) {
      # mklink honours Developer Mode; New-Item -ItemType SymbolicLink in 5.1 needs elevation.
      $flag = ''
      if ([IO.Directory]::Exists($src)) { $flag = '/D ' }
      $out = cmd.exe /c "mklink $flag`"$dest`" `"$src`"" 2>&1
      if ($LASTEXITCODE -ne 0) { throw "symlink creation refused: $(($out | Out-String).Trim())" }
    } else {
      [void](New-Item -ItemType SymbolicLink -Path $dest -Target $src)
    }
  } else {
    Copy-Item -LiteralPath $src -Destination $dest -Recurse -Force
    Set-Record $dest (Get-TreeHash $dest)
  }
}

$script:problems = 0
function Write-Problem([string]$label, [string]$detail) {
  Write-Host "  x $label"
  Write-Host "      $detail"
  $script:problems++
}

# Copies recorded by an earlier run that are no longer selected, plus links into this folder
# left in any preset folder (asset deleted, harness deselected, switched to copy mode).
$staleCopies = @(@($copies.Keys) | ForEach-Object { Get-RecordPath $_ } | Where-Object { -not $keep.Contains((Get-Normal $_)) })
$strayLinks = New-Object System.Collections.Generic.List[object]
foreach ($dir in (Get-AllPresetDirs)) {
  if (-not [IO.Directory]::Exists($dir)) { continue }
  foreach ($n in (Get-SortedNames $dir)) {
    $p = [IO.Path]::Combine($dir, $n)
    $item = Get-ItemOrNull $p
    if (-not (Test-Link $item) -or $keep.Contains((Get-Normal $p))) { continue }
    $to = Get-LinkTo $item
    if (-not [IO.Path]::IsPathRooted($to)) { $to = [IO.Path]::Combine($dir, $to) }
    if (Test-Inside $to $Root) { $strayLinks.Add([pscustomobject]@{ path = $p; target = [IO.Path]::GetFullPath($to) }) }
  }
}

if ($remove) {
  foreach ($e in $entries) {
    $now = Get-State $e.dest
    if ($now.kind -eq 'link' -or $now.kind -eq 'copy' -or ($force -and $now.kind -eq 'edited')) {
      Remove-Installed $e.dest
      Write-Host "  - $($e.label)"
    } elseif ($now.kind -eq 'edited') {
      Remove-Record $e.dest
      Write-Host "  ! $($e.label)"
      Write-Host '      edited since it was installed; left in place (--force removes it)'
    }
  }
  foreach ($p in $staleCopies) {
    if ($null -eq (Get-ItemOrNull $p)) { continue }
    if ((Get-State $p).kind -eq 'copy' -or $force) {
      Remove-Installed $p
      Write-Host "  - $(Get-Tilde $p)"
    } else {
      Write-Host "  ! $(Get-Tilde $p)"
      Write-Host '      edited since it was installed; left in place (--force removes it)'
    }
  }
  foreach ($s in $strayLinks) {
    Remove-Installed $s.path
    Write-Host "  - $(Get-Tilde $s.path)"
  }
  if ([IO.File]::Exists($StateFile)) { [IO.File]::Delete($StateFile) }
  Write-Host ''
  Write-Host 'Uninstalled. Start a new session in each tool to drop the assets.'
  exit 0
}

if ($entries.Count -eq 0 -and $staleCopies.Count -eq 0 -and $strayLinks.Count -eq 0) {
  Write-Host 'Nothing selected. Run with --setup to choose the tools to install for.'
  exit 0
}

# Symlinks need Developer Mode (or an elevated prompt) on Windows; say so before failing on each.
if ($linkMode -and $onWindows -and -not $check) {
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  $devMode = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' -Name AllowDevelopmentWithoutDevLicense -ErrorAction SilentlyContinue).AllowDevelopmentWithoutDevLicense -eq 1
  if (-not $admin -and -not $devMode) {
    Write-Host '--link creates symlinks, which needs Windows Developer Mode.'
    Write-Host 'Opening Settings: turn on Developer Mode and run this again, or install with --copy.'
    Start-Process 'ms-settings:developers'
    exit 1
  }
}

$changed = 0
foreach ($e in $entries) {
  $label = $e.label
  if ($null -eq (Get-ItemOrNull $e.src)) {
    Write-Problem $label "source does not exist: $($e.src) (run npm run build first?)"
    continue
  }
  $now = Get-State $e.dest

  # Already as wanted?
  if ($linkMode -and $now.kind -eq 'link' -and (Get-Normal $now.to) -ceq (Get-Normal $e.src)) {
    Write-Host "  = $label"
    continue
  }
  if (-not $linkMode -and $now.kind -eq 'copy' -and (Get-Recorded $e.dest) -eq (Get-TreeHash $e.src)) {
    Write-Host "  = $label"
    continue
  }
  # A hand-made copy identical to ours (e.g. from the old copy instructions) is adopted.
  if (-not $linkMode -and $now.kind -eq 'foreign' -and (Get-TreeHash $e.dest) -eq (Get-TreeHash $e.src)) {
    if (-not $check) { Set-Record $e.dest (Get-TreeHash $e.dest) }
    Write-Host "  = $label  (already identical; now tracked)"
    continue
  }

  # Never overwrite what the user made or edited, unless asked to.
  if (($now.kind -eq 'foreign' -or $now.kind -eq 'edited') -and -not $force) {
    if ($now.kind -eq 'edited') { $what = 'was edited since it was installed' }
    elseif ($now.dir) { $what = 'is a directory this installer did not create' }
    else { $what = 'is a file this installer did not create' }
    Write-Problem $label "$what; move it away or rerun with --force to overwrite it"
    continue
  }

  if ($check) {
    switch ($now.kind) {
      'missing' { $detail = 'not installed' }
      'link' { if ($linkMode) { $detail = "links to $($now.to)" } else { $detail = 'is a link; expected a copy' } }
      'copy' { if ($linkMode) { $detail = 'is a copy; expected a link' } else { $detail = 'outdated copy' } }
      'foreign' { $detail = 'differs from this version' }
      default { $detail = 'edited since it was installed' }
    }
    Write-Problem $label $detail
    continue
  }

  if ($now.kind -eq 'missing') { $verb = '+' } else { $verb = '~' }
  try {
    if ($now.kind -ne 'missing') { Remove-Installed $e.dest }
    New-Installed $e.src $e.dest
  } catch {
    Write-Problem $label $_.Exception.Message
    if ($linkMode) { Write-Host '      Symlink creation refused - enable Developer Mode (Windows) or run elevated, or install with --copy.' }
    continue
  }
  $changed++
  Write-Host "  $verb $label"
  if ($linkMode) { Write-Host "      -> $($e.src)" }
}

foreach ($p in $staleCopies) {
  if ($null -eq (Get-ItemOrNull $p)) {
    Remove-Record $p
    continue
  }
  $kind = (Get-State $p).kind
  if ($check) {
    Write-Problem (Get-Tilde $p) 'installed earlier but no longer selected'
    continue
  }
  if ($kind -eq 'copy' -or $force) {
    Remove-Installed $p
    $changed++
    Write-Host "  - $(Get-Tilde $p)  (no longer selected)"
  } else {
    Remove-Record $p
    Write-Host "  ! $(Get-Tilde $p)"
    Write-Host '      no longer selected, but edited since it was installed; left in place'
  }
}

foreach ($s in $strayLinks) {
  if ($check) {
    Write-Problem (Get-Tilde $s.path) "stale link to $($s.target)"
    continue
  }
  Remove-Installed $s.path
  $changed++
  Write-Host "  - $(Get-Tilde $s.path)  (stale link removed)"
}

if (-not $check) { Save-State }

Write-Host ''
if ($script:problems) {
  if ($check) { Write-Host "$($script:problems) item(s) need attention." } else { Write-Host "$($script:problems) item(s) could not be installed." }
  exit 1
}
if ($selected.Count) { $scope = " for $($selected -join ', ')" } else { $scope = '' }
if ($check) { $did = 'verified' } else { $did = 'installed' }
if ($version) { $v = $version } else { $v = 'unknown' }
Write-Host "$($entries.Count) asset(s) $did$scope ($mode mode, version $v)."
if ($changed -and -not $check) { Write-Host 'Start a new session in each tool to pick up the changes.' }
exit 0
