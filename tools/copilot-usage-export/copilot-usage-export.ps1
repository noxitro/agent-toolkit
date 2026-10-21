# GitHub Copilot(Copilot CLI と、同じ記録を使うデスクトップ版)の使用量とセッションの経過を、この PC の記録から書き出す。
# モデルは呼ばないので、トークンもクレジットも使わない。
#
#   copilot-usage-export.ps1                     直近 7 日に動いたセッションを書き出す
#   copilot-usage-export.ps1 -Since 2026-10-19   その日以降(UTC)に動いたセッションだけ
#   copilot-usage-export.ps1 -SessionId <id>     特定のセッションだけ(前方一致)
#   copilot-usage-export.ps1 -ToolOutput all     記録にツールの結果も入れる(none / fail(既定) / all)
#   copilot-usage-export.ps1 -Format cli         記録を Copilot CLI の /share file と同じ形式で出す(record(既定) / cli / both)
#   copilot-usage-export.ps1 -Raw                生の events.jsonl も output\raw\ に複製する
#   copilot-usage-export.ps1 -OutDir <path>      出力先(既定はこのフォルダの output\)
#   copilot-usage-export.ps1 -Quiet              画面に出さず output\copilot-usage-export.log に追記する(自動実行用)
#
# 出すもの:
#   output\usage-<日付>.csv                         日ごとの CSV(セッションの開始日。再実行すると同じセッションの行を差し替える)
#   output\sessions\<日付>\<時刻>_<ID 8 桁>.md      セッションごとの記録(依頼・応答・ツール呼び出し・サブエージェント・消費)
#   output\cli\<日付>\copilot-session-<ID>.md       -Format cli / both のとき。Copilot CLI 1.0.100 の /share file と同じ構造
#
# 読む場所(Copilot CLI とデスクトップ版が共用、文書化されていない内部構造):
#   %USERPROFILE%\.copilot\session-store.db               assistant_usage_events(1 行 = 1 モデル呼び出し)、sessions(cwd・リポジトリ・要約)
#   %USERPROFILE%\.copilot\data.db                        sessions(デスクトップ版のセッション名)、session_context_usage(コンテキスト使用率)
#   %USERPROFILE%\.copilot\session-state\<ID>\events.jsonl セッションの全イベント
# data.db にある認証情報の表(accounts・settings)は読まない。元のファイルには書き込まない。
# クレジットは total_nano_aiu / 1e9。
#
# 列が無い・表が無いときは黙って 0 を出さず、理由を表示して終了コード 1 で止まる(Copilot の版上げで構造が変わったとき用)。
# Node.js も Python も不要。Windows 標準の PowerShell 5.1 と winsqlite3.dll(Windows 10/11 同梱)で動く。
# UTF-8 (BOM 付き) で保存する。

param(
  [string]$Since,
  [string]$SessionId = '',
  [string]$OutDir,
  [string]$CopilotHome,
  [ValidateSet('none', 'fail', 'all')][string]$ToolOutput = 'fail',
  [ValidateSet('record', 'cli', 'both')][string]$Format = 'record',
  [switch]$Raw,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot 'output' }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$logFile = Join-Path $OutDir 'copilot-usage-export.log'

function Say([string]$msg) {
  if ($Quiet) { Add-Content -LiteralPath $logFile -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $msg) -Encoding UTF8 }
  else { Write-Host $msg }
}
function Fail([string]$msg) { Say $msg; exit 1 }

$wantRecord = $Format -ne 'cli'
$wantCli = $Format -ne 'record'
if (-not $CopilotHome) { $CopilotHome = Join-Path $env:USERPROFILE '.copilot' }
if (-not $Since) { $Since = (Get-Date).ToUniversalTime().AddDays(-7).ToString('yyyy-MM-dd') }
if ($Since -notmatch '^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$') { Fail "-Since は YYYY-MM-DD(UTC)で指定する: $Since" }
if ($SessionId -and $SessionId -notmatch '^[0-9a-fA-F-]+$') { Fail '-SessionId は UUID(前方一致可)で指定する' }

$storeDb = Join-Path $CopilotHome 'session-store.db'
$stateDir = Join-Path $CopilotHome 'session-state'
if (-not (Test-Path $storeDb)) { Fail "記録 DB が無い: $storeDb(Copilot を一度も使っていないか、COPILOT_HOME が別の場所)" }

# --- winsqlite3.dll を直接呼ぶ最小のラッパー(読み取り専用の用途) ---
if (-not ('CopilotUsage.WinSqlite' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
namespace CopilotUsage {
public static class WinSqlite {
  const string Dll = "winsqlite3.dll";
  [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_open_v2(byte[] filename, out IntPtr db, int flags, IntPtr vfs);
  [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_prepare_v2(IntPtr db, byte[] sql, int nByte, out IntPtr stmt, IntPtr tail);
  [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_step(IntPtr stmt);
  [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_column_count(IntPtr stmt);
  [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] static extern IntPtr sqlite3_column_name(IntPtr stmt, int i);
  [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] static extern IntPtr sqlite3_column_text(IntPtr stmt, int i);
  [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_finalize(IntPtr stmt);
  [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_close_v2(IntPtr db);
  [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] static extern IntPtr sqlite3_errmsg(IntPtr db);
  static string Utf8(IntPtr p) {
    if (p == IntPtr.Zero) return null;
    int len = 0; while (Marshal.ReadByte(p, len) != 0) len++;
    byte[] b = new byte[len]; Marshal.Copy(p, b, 0, len);
    return Encoding.UTF8.GetString(b);
  }
  static byte[] Z(string s) { return Encoding.UTF8.GetBytes(s + "\0"); }
  public static List<Dictionary<string, string>> Query(string path, string[] sqls) {
    IntPtr db;
    int rc = sqlite3_open_v2(Z(path), out db, 0x2 /* READWRITE: 一時コピーに対して開く */, IntPtr.Zero);
    if (rc != 0) throw new Exception("sqlite3_open_v2 failed rc=" + rc + " path=" + path);
    try {
      List<Dictionary<string, string>> rows = new List<Dictionary<string, string>>();
      foreach (string sql in sqls) {
        IntPtr st;
        rc = sqlite3_prepare_v2(db, Z(sql), -1, out st, IntPtr.Zero);
        if (rc != 0) throw new Exception("prepare failed: " + Utf8(sqlite3_errmsg(db)) + " sql=" + sql);
        int n = sqlite3_column_count(st);
        string[] names = new string[n];
        for (int i = 0; i < n; i++) names[i] = Utf8(sqlite3_column_name(st, i));
        rows.Clear();
        while ((rc = sqlite3_step(st)) == 100) {
          Dictionary<string, string> d = new Dictionary<string, string>();
          for (int i = 0; i < n; i++) d[names[i]] = Utf8(sqlite3_column_text(st, i));
          rows.Add(d);
        }
        sqlite3_finalize(st);
        if (rc != 101) throw new Exception("step failed rc=" + rc + ": " + Utf8(sqlite3_errmsg(db)));
      }
      return rows; // 最後の SQL の結果
    } finally { sqlite3_close_v2(db); }
  }
}
}
'@
}

# --- DB は使用中(WAL)なので、一時フォルダにコピーしてから読む ---
$tmp = Join-Path $env:TEMP ('copilot-usage-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  foreach ($base in @('session-store.db', 'data.db')) {
    foreach ($suffix in @('', '-wal', '-shm')) {
      $src = Join-Path $CopilotHome ($base + $suffix)
      if (Test-Path $src) { Copy-Item -Path $src -Destination (Join-Path $tmp ($base + $suffix)) -Force }
    }
  }
  $store = Join-Path $tmp 'session-store.db'
  $app = Join-Path $tmp 'data.db'
  $hasApp = Test-Path $app

  # --- 構造の確認(無ければ止まる) ---
  $cols = [CopilotUsage.WinSqlite]::Query($store, @('pragma table_info(assistant_usage_events)')) | ForEach-Object { $_['name'] }
  if (-not $cols) { Fail 'session-store.db に assistant_usage_events 表が無い。Copilot の版が変わって記録の形が変わった可能性がある。' }
  $need = @('session_id', 'agent_id', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'total_nano_aiu', 'duration_ms', 'reasoning_effort', 'created_at')
  $missing = $need | Where-Object { $cols -notcontains $_ }
  if ($missing) { Fail ("assistant_usage_events に必要な列が無い: " + ($missing -join ', ') + "`n今ある列: " + ($cols -join ', ')) }

  # 期間内に 1 回でも呼び出しがあったセッションを選び、そのセッションは全期間を集計する(期間の境目で欠けないように)
  $sinceLit = $Since.Replace("'", "''")
  $pick = "select distinct session_id from assistant_usage_events where created_at >= '$sinceLit'"
  if ($SessionId) { $pick += " and session_id like '" + $SessionId.Replace("'", "''") + "%'" }

  $appJoin = ''
  $appCols = 'null as app_title, null as app_type, null as context_peak_pct'
  $sqls = @()
  if ($hasApp) {
    $sqls += "attach database '" + $app.Replace("'", "''") + "' as app"
    $appJoin = ' left join app.sessions a on a.id = e.session_id left join (select session_id, max(100.0 * current_tokens / token_limit) as peak from app.session_context_usage where token_limit > 0 group by session_id) c on c.session_id = e.session_id'
    $appCols = 'a.title as app_title, a.session_type as app_type, round(max(c.peak), 0) as context_peak_pct'
  }
  $sqls += @"
select e.session_id as session_id,
       coalesce(e.agent_id, '(main)') as agent,
       count(*) as calls,
       round(sum(e.total_nano_aiu) / 1000000000.0, 4) as credits,
       sum(e.input_tokens) as input_tokens,
       sum(e.cache_read_tokens) as cache_read_tokens,
       sum(e.cache_write_tokens) as cache_write_tokens,
       sum(e.output_tokens) as output_tokens,
       sum(e.reasoning_tokens) as reasoning_tokens,
       round(sum(e.duration_ms) / 1000.0, 1) as model_seconds,
       group_concat(distinct e.model) as models,
       group_concat(distinct e.reasoning_effort) as reasoning_effort,
       min(e.created_at) as first_call_utc,
       max(e.created_at) as last_call_utc,
       s.cwd as cwd,
       s.repository as repository,
       s.branch as branch,
       substr(coalesce(s.summary, ''), 1, 80) as summary,
       $appCols
from assistant_usage_events e
left join sessions s on s.id = e.session_id$appJoin
where e.session_id in ($pick)
group by e.session_id, coalesce(e.agent_id, '(main)')
order by min(e.created_at), coalesce(e.agent_id, '(main)')
"@
  $rows = [CopilotUsage.WinSqlite]::Query($store, $sqls)
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

if (-not $rows -or $rows.Count -eq 0) { Say "該当するセッションが無い(Since=$Since)。"; exit 0 }

# --- 秘密情報の疑いを数える(記録は書き換えない。見つかったら警告だけ出す) ---
$script:suspectCount = 0
$script:suspectKinds = @{}
$secretRules = @(
  @('-----BEGIN [A-Z ]*PRIVATE KEY-----', '秘密鍵'),
  @('\bgithub_pat_[A-Za-z0-9_]{20,}', 'アクセストークン'),
  @('\bgh[pousr]_[A-Za-z0-9]{20,}', 'アクセストークン'),
  @('\bglpat-[A-Za-z0-9_\-]{20,}', 'アクセストークン'),
  @('\bsk-[A-Za-z0-9_\-]{20,}', 'API キー(sk-)'),
  @('\bAIza[0-9A-Za-z_\-]{35}', 'API キー(AIza)'),
  @('\bAKIA[0-9A-Z]{16}\b', 'アクセスキー(AKIA)'),
  @('\bxox[abprs]-[A-Za-z0-9\-]{10,}', 'アクセストークン'),
  @('(?i)\b(Bearer|Basic)\s+[A-Za-z0-9\-\._~\+/]{16,}=*', '認証ヘッダーの値'),
  # KEY=値 の形。値は英字と数字を含む 12 文字以上(「input_tokens: 17713」のような数値は数えない)
  @('(?i)\b[A-Z0-9_]*(?:API_?KEY|ACCESS_?KEY|TOKEN(?!S)|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*\s*[=:]\s*["'']?(?=[^\s"'',;]*[A-Za-z])(?=[^\s"'',;]*\d)[^\s"'',;]{12,}', 'KEY=値 の形')
)
function Scan([string]$s) {
  if (-not $s) { return $s }
  foreach ($r in $secretRules) {
    $n = [regex]::Matches($s, $r[0]).Count
    if ($n -gt 0) { $script:suspectCount += $n; $script:suspectKinds[$r[1]] = 1 }
  }
  return $s
}
function Cap([string]$s, [int]$n) {
  if (-not $s) { return '' }
  if ($s.Length -le $n) { return $s }
  return $s.Substring(0, $n) + "`n…(以下 " + ($s.Length - $n) + " 文字省略)"
}
function OneLine([string]$s, [int]$n) {
  if (-not $s) { return '' }
  $t = ($s -replace '\s+', ' ').Trim()
  if ($t.Length -gt $n) { $t = $t.Substring(0, $n) + '…' }
  return $t
}
function Fence([string]$text, [string]$lang = '') {
  # 本文に含まれるバッククォートの連続より長い囲みにする
  $max = 2
  foreach ($m in [regex]::Matches($text, '`+')) { if ($m.Length -gt $max) { $max = $m.Length } }
  $f = '`' * ($max + 1)
  return "$f$lang`n$text`n$f"
}

# --- events.jsonl を読む ---
Add-Type -AssemblyName System.Web.Extensions
$ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$ser.MaxJsonLength = [int]::MaxValue
$ser.RecursionLimit = 256
# 使わない大きなイベントは解析せずに飛ばす(速さのため)
$skipTypes = @('model.', 'hook.', 'session.binary_asset', 'system.message', 'skill.context_delivered_ref', 'session.usage_checkpoint', 'assistant.turn_start', 'assistant.turn_end', 'external_tool.')

function G($d, [string]$k) { if ($d -is [System.Collections.IDictionary] -and $d.ContainsKey($k)) { return $d[$k] } return $null }
function Dur($a, $b) { try { return [math]::Round(([datetime]$b - [datetime]$a).TotalSeconds, 1) } catch { return $null } }
function ToolSummary([string]$name, $a) {
  if (-not ($a -is [System.Collections.IDictionary])) { return OneLine ([string]$a) 200 }
  foreach ($k in @('command', 'path', 'pattern', 'query', 'url', 'skill', 'agent_type')) {
    $v = G $a $k
    if ($v) {
      $extra = ''
      if ($name -eq 'task') { $extra = ' / ' + (G $a 'description') }
      return OneLine ("$k=" + [string]$v + $extra) 240
    }
  }
  return OneLine ($ser.Serialize($a)) 240
}

# --- -Format cli: Copilot CLI(1.0.100)がイベントからタイムラインを組む規則をなぞる ---
# 対応するもの: 依頼・応答・ツール呼び出し(サブエージェントの中身は委譲したツールの下にまとめる)・エラー・情報・警告・
# 会話の要約・完了の報告・通知・中断。CLI と同じく、サブエージェントへの指示と、委譲したツールの結果(報告)は出ない。
$cliHints = @{
  sign_in = 'Run /login to sign in again.'; switch_account = 'Run /user switch to use a different account.'
  show_account = 'Run /user show to check which account is in use.'; review_sandbox_policy = 'Run /sandbox to review or widen the sandbox policy.'
  allow_sandbox_outbound = 'Run /sandbox to allow outbound network access.'; rewind_conversation = 'Run /rewind to discard the blocked request before continuing.'
}
function CliHint([string]$msg, $remediation) {
  $h = if ($remediation -is [string]) { $cliHints[$remediation] } else { $null }
  if (-not $h) { return $msg }
  $t = $msg.TrimEnd(); if ($t.Length -eq 0) { return $h }
  return "$t $h"
}
function CliGroup($info, [string]$p) {
  # サブエージェントの最初の出力が届いたら、委譲したツールの項目をまとまり(group)に変える
  $x = $info.cliIdx[$p]
  if (-not $x -or $x.nested) { return $null }
  if ($x.k -eq 'tool') { $x.k = 'group'; $x.children = New-Object System.Collections.ArrayList }
  return $x
}
function CliModelArg($a0, $d) {
  # 完了時、計測値にモデル名があれば引数に model として足す(CLI と同じ)
  $pr = G (G $d 'toolTelemetry') 'properties'
  $m = G $pr 'resolved_model'; if ($null -eq $m) { $m = G $pr 'model' }
  if (-not ($m -is [string]) -or -not ($a0 -is [System.Collections.IDictionary])) { return $a0 }
  $o = New-Object 'System.Collections.Generic.Dictionary[string,object]'
  foreach ($k in $a0.Keys) { $o[$k] = $a0[$k] }
  $o['model'] = $m
  return $o
}
function CliAbort($x) { $x.done = $true; $x.rtype = 'failure'; $x.log = 'Operation aborted by user' }
function CliNotice($k, [string]$content) {
  $t = [string](G $k 'type'); $desc = G $k 'description'
  $agent = if ($desc) { $desc } else { G $k 'agentId' }
  $shell = if ($desc) { '"' + $desc + '"' } else { G $k 'shellId' }
  switch ($t) {
    'agent_completed' { return @(('Background agent "{0}" ({1}) {2}' -f $agent, (G $k 'agentType'), $(if ((G $k 'status') -eq 'completed') { 'completed' } else { 'failed' })), (G $k 'prompt')) }
    'shell_completed' { $ec = G $k 'exitCode'; return @(('Shell {0} {1}' -f $shell, $(if ($null -eq $ec -or $ec -eq 0) { 'completed' } else { "exited (code $ec)" })), $null) }
    'shell_detached_completed' { return @("Detached shell $shell completed", $null) }
    'agent_idle' { return @(('Background agent "{0}" ({1}) completed.' -f $agent, (G $k 'agentType')), $null) }
    'instruction_discovered' { return @('Discovered ' + $(if ($desc) { $desc } else { G $k 'sourcePath' }), $null) }
    'workflow_completed' {
      $f = G $k 'failure'
      $lines = @(); if (G $k 'resultPreview') { $lines += 'Result preview: ' + (G $k 'resultPreview') }
      if ($null -ne $f) { $lines += 'Failure: ' + $(if ($f -is [string]) { $f } else { $ser.Serialize($f) }) }
      if (G $k 'retryGuidance') { $lines += 'Retry guidance: ' + (G $k 'retryGuidance') }
      return @(('Workflow "{0}" {1}' -f (G $k 'workflowName'), (G $k 'status')), $(if ($lines) { $lines -join "`n" } else { $null }))
    }
    default { return @($content, $null) }
  }
}
function Add-CliEvent($info, $e, [string]$type, $d, $ts, $aid) {
  $list = $info.cli
  # サブエージェントの出来事は parentToolCallId(無ければ agentId)で委譲元のツールにつなぐ
  $p = [string](G $d 'parentToolCallId'); if (-not $p) { $p = [string]$aid }; if (-not $p) { $p = [string](G $d 'agentId') }
  switch ($type) {
    'user.message' {
      $src = [string](G $d 'source'); $c = [string](G $d 'content')
      if (-not $p -and $c -and (-not $src -or $src -eq 'user' -or $src -match '^(command-|schedule-|autopilot-)')) { [void]$list.Add(@{ k = 'user'; ts = $ts; text = $c }) }
    }
    'assistant.message' {
      $box = $null
      if ($p) { $g = CliGroup $info $p; if ($g) { $box = $g.children } } else { $box = $list }
      if ($null -eq $box) { return }
      $c = [string](G $d 'content')
      if ($c) {
        $mk = $p + '|' + [string](G $d 'messageId')
        if ($info.cliMsg.ContainsKey($mk)) { $info.cliMsg[$mk].text = $c }
        else { $it = @{ k = 'copilot'; ts = $ts; text = $c }; $info.cliMsg[$mk] = $it; [void]$box.Add($it) }
      }
      foreach ($r in @(G $d 'toolRequests')) {
        if (-not $r) { continue }
        $cid = [string](G $r 'toolCallId')
        if (-not $p -and $info.cliIdx.ContainsKey($cid)) { continue }
        $it = @{ k = 'tool'; ts = $ts; callId = $cid; name = [string](G $r 'name'); title = (G $r 'toolTitle'); intent = (G $r 'intentionSummary'); args = (G $r 'arguments'); done = $false; nested = [bool]$p }
        $info.cliIdx[$cid] = $it; [void]$box.Add($it)
      }
    }
    'tool.user_requested' {
      $cid = [string](G $d 'toolCallId'); $nm = [string](G $d 'toolName'); $a0 = G $d 'arguments'
      $title = if ($nm -eq 'local_shell' -and (G $a0 'command')) { '$ ' + (G $a0 'command') } else { $null }
      $it = @{ k = 'tool'; ts = $ts; callId = $cid; name = $nm; title = $title; intent = $null; args = $a0; done = $false; nested = $false }
      $info.cliIdx[$cid] = $it; [void]$list.Add($it)
    }
    'tool.execution_complete' {
      $x = $info.cliIdx[[string](G $d 'toolCallId')]
      if (-not $x) { return }
      $x.done = $true; $x.args = CliModelArg $x.args $d
      if ($x.k -eq 'tool') {
        $x.ts = $ts
        if (G $d 'success') { $x.rtype = 'success'; $x.log = [string](G (G $d 'result') 'content') }
        else { $er = G $d 'error'; $x.rtype = 'failure'; $x.log = CliHint ([string](G $er 'message')) (G $er 'remediation') }
      }
    }
    'abort' {
      if ($p) { return }
      foreach ($x in $list) {
        if ($x.done) { continue }
        if ($x.k -eq 'tool') { CliAbort $x }
        elseif ($x.k -eq 'group') { $x.done = $true; foreach ($c in $x.children) { if ($c.k -eq 'tool' -and -not $c.done) { CliAbort $c } } }
      }
    }
    'session.error' { [void]$list.Add(@{ k = 'error'; ts = $ts; text = (CliHint ([string](G $d 'message')) (G $d 'remediation')) }) }
    'session.info' { if ((G $d 'infoType') -ne 'file_created') { [void]$list.Add(@{ k = 'info'; ts = $ts; text = [string](G $d 'message') }) } }
    'session.warning' { [void]$list.Add(@{ k = 'warning'; ts = $ts; text = (CliHint ([string](G $d 'message')) (G $d 'remediation')) }) }
    'session.compaction_complete' { if ((G $d 'success') -and -not $p) { [void]$list.Add(@{ k = 'compaction'; ts = $ts }) } }
    'session.task_complete' { [void]$list.Add(@{ k = 'task'; ts = $ts; text = [string](G $d 'summary') }) }
    'system.notification' {
      $kind = G $d 'kind'
      if ((G $kind 'type') -ne 'new_inbox_message') { $nt = CliNotice $kind ([string](G $d 'content')); [void]$list.Add(@{ k = 'notice'; ts = $ts; text = $nt[0]; detail = $nt[1] }) }
    }
  }
}

function Read-Session([string]$sid) {
  $info = [ordered]@{
    exists = $false; meta = $null; mainRole = 'main'; roles = @{}
    ended = 'no-events'; shutdown = $null; userRequests = 0; perAgent = @{}; items = New-Object System.Collections.ArrayList
    skills = New-Object System.Collections.ArrayList; errors = 0; unparsed = 0; firstPrompt = ''
    # -Format cli 用: Copilot CLI のタイムラインと同じ単位の項目(callId → 項目、親 callId|messageId → 応答)
    cli = New-Object System.Collections.ArrayList; cliIdx = @{}; cliMsg = @{}; lastTs = $null
  }
  $path = Join-Path $stateDir "$sid\events.jsonl"
  if (-not (Test-Path $path)) { return $info }
  $info.exists = $true; $info.ended = 'no-shutdown'
  $tools = @{}; $msgs = @{}; $sawUser = $false
  $reader = New-Object System.IO.StreamReader($path, [Text.Encoding]::UTF8)
  try {
    while ($null -ne ($line = $reader.ReadLine())) {
      if (-not $line) { continue }
      $m = [regex]::Match($line, '^\{"type":"([^"]+)"')
      if ($m.Success) {
        $t0 = $m.Groups[1].Value
        $skip = $false
        foreach ($p in $skipTypes) { if ($t0.StartsWith($p)) { $skip = $true; break } }
        if ($skip) { continue }
      }
      try { $e = $ser.DeserializeObject($line) } catch { $info.unparsed++; continue }
      $type = G $e 'type'; $d = G $e 'data'; $ts = G $e 'timestamp'; $aid = G $e 'agentId'
      $key = if ($aid) { $aid } else { '(main)' }
      if (-not $info.perAgent.ContainsKey($key)) { $info.perAgent[$key] = [ordered]@{ tools = 0; fails = 0 } }
      if ($ts) { $info.lastTs = $ts }
      if ($wantCli) { Add-CliEvent $info $e $type $d $ts $aid }
      switch ($type) {
        'session.start' { $info.meta = $d }
        'session.resume' { [void]$info.items.Add(@{ k = 'note'; ts = $ts; text = '(セッションを再開)' }) }
        'subagent.selected' {
          # 最初の依頼より前に選ばれたエージェント = セッション自体の役(--agent で始めたとき)
          if (-not $aid -and -not $sawUser) { $info.mainRole = [string](G $d 'agentName') }
        }
        'session.model_change' {
          [void]$info.items.Add(@{ k = 'note'; ts = $ts; text = ('モデル変更: {0} → {1}(推論強度 {2}、{3})' -f (G $d 'previousModel'), (G $d 'newModel'), (G $d 'reasoningEffort'), (G $d 'source')) })
        }
        'session.mode_changed' { [void]$info.items.Add(@{ k = 'note'; ts = $ts; text = ('モード変更: {0} → {1}' -f (G $d 'previousMode'), (G $d 'newMode')) }) }
        'user.message' {
          $content = [string](G $d 'content')
          if (-not $aid) {
            $sawUser = $true
            $auto = [bool](G $d 'isAutopilotContinuation')
            if (-not $auto) { $info.userRequests++ }
            if (-not $info.firstPrompt) { $info.firstPrompt = $content }
            $att = G $d 'attachments'
            [void]$info.items.Add(@{ k = 'user'; ts = $ts; text = $content; auto = $auto; attachments = $(if ($att) { @($att).Count } else { 0 }) })
          }
        }
        'skill.invoked' {
          $name = [string](G $d 'name')
          [void]$info.skills.Add($name)
          [void]$info.items.Add(@{ k = 'note'; ts = $ts; agent = $aid; text = "スキル起動: $name" })
        }
        'assistant.message' {
          # 分割して届く応答は messageId でつなぐ
          $mid = [string](G $d 'messageId')
          $content = [string](G $d 'content')
          if ($mid -and $msgs.ContainsKey($mid)) { $msgs[$mid].text += $content }
          else {
            $it = @{ k = 'assistant'; ts = $ts; agent = $aid; model = (G $d 'model'); text = $content }
            if ($mid) { $msgs[$mid] = $it }
            [void]$info.items.Add($it)
          }
        }
        'tool.execution_start' {
          $info.perAgent[$key].tools++
          $name = [string](G $d 'toolName')
          $it = @{ k = 'tool'; ts = $ts; agent = $aid; name = $name; args = (ToolSummary $name (G $d 'arguments')); ok = $null; sec = $null; err = ''; result = ''
                   prompt = $(if ($name -eq 'task') { [string](G (G $d 'arguments') 'prompt') } else { '' }) }
          $tools[[string](G $d 'toolCallId')] = $it
          [void]$info.items.Add($it)
        }
        'tool.execution_complete' {
          $it = $tools[[string](G $d 'toolCallId')]
          if ($it) {
            $it.ok = [bool](G $d 'success'); $it.sec = Dur $it.ts $ts
            $er = G $d 'error'; if ($er) { $it.err = [string](G $er 'message') }
            $res = G $d 'result'
            if ($res) { $c = G $res 'content'; if (-not $c) { $c = G $res 'detailedContent' }; $it.result = [string]$c }
            if (-not $it.ok) { $info.perAgent[$key].fails++ }
          }
        }
        'subagent.started' {
          $info.roles[[string]$aid] = [string](G $d 'agentName')
          [void]$info.items.Add(@{ k = 'substart'; ts = $ts; agent = $aid; name = (G $d 'agentName'); model = (G $d 'model'); type = (G $d 'agentType'); source = (G $d 'modelSelectionSource') })
        }
        'subagent.completed' {
          [void]$info.items.Add(@{ k = 'subend'; ts = $ts; agent = $aid; name = (G $d 'agentName'); toolCalls = (G $d 'totalToolCalls'); tokens = (G $d 'totalTokens'); ms = (G $d 'durationMs') })
        }
        'permission.requested' {
          $pr = G $d 'permissionRequest'
          $what = (G $pr 'url'); if (-not $what) { $what = G $pr 'path' }; if (-not $what) { $what = G $pr 'fullCommandText' }
          [void]$info.items.Add(@{ k = 'note'; ts = $ts; agent = $aid; text = ('承認の要求: {0} {1} {2}' -f (G $pr 'kind'), (G $pr 'intention'), (OneLine ([string]$what) 160)) })
        }
        'session.error' { $info.errors++; [void]$info.items.Add(@{ k = 'note'; ts = $ts; agent = $aid; text = ('エラー: {0} {1}' -f (G $d 'errorType'), (OneLine ([string](G $d 'message')) 300)) }) }
        'abort' { [void]$info.items.Add(@{ k = 'note'; ts = $ts; agent = $aid; text = ('中断: ' + (G $d 'reason')) }) }
        'session.compaction_complete' { [void]$info.items.Add(@{ k = 'note'; ts = $ts; text = ('会話の要約(compaction): 要約前 {0} トークン' -f (G $d 'preCompactionTokens')) }) }
        'session.task_complete' { [void]$info.items.Add(@{ k = 'note'; ts = $ts; agent = $aid; text = ('完了の報告: ' + (OneLine ([string](G $d 'summary')) 400)) }) }
        'session.shutdown' { $info.shutdown = $d; $info.ended = 'shutdown' }
      }
    }
  } finally { $reader.Close() }
  return $info
}

# --- セッションごとに読み、CSV 行を作る ---
$sessions = @{}
foreach ($sid in ($rows | ForEach-Object { $_['session_id'] } | Select-Object -Unique)) { $sessions[$sid] = Read-Session $sid }

$records = @(foreach ($r in $rows) {
  $sid = $r['session_id']; $s = $sessions[$sid]
  $source = if ($r['app_title'] -or $r['app_type']) { 'desktop' } else { 'cli' }
  $title = if ($r['app_title']) { $r['app_title'] } elseif ($r['summary']) { $r['summary'] } else { OneLine $s.firstPrompt 80 }
  $agent = $r['agent']
  $role = if ($agent -eq '(main)') { $s.mainRole } elseif ($s.roles.ContainsKey($agent)) { $s.roles[$agent] } else { '(不明)' }
  $pa = $s.perAgent[$agent]
  $repo = $r['repository']
  if (-not $repo -and $s.meta) { $ctx = G $s.meta 'context'; $repo = G $ctx 'repository'; if (-not $repo) { $gr = G $ctx 'gitRoot'; if ($gr) { $repo = Split-Path -Leaf $gr } } }
  $final = ''
  if ($agent -eq '(main)' -and $s.shutdown) { $n = G $s.shutdown 'totalNanoAiu'; if ($null -eq $n) { $n = G (G $s.shutdown 'accountingSnapshot') 'totalNanoAiu' }; if ($null -ne $n) { $final = [math]::Round([double]$n / 1e9, 4) } }
  $firstLocal = ([datetime]::Parse($r['first_call_utc'], $null, 'AdjustToUniversal, AssumeUniversal')).ToLocalTime()
  [pscustomobject]@{
    source             = $source
    repo               = $repo
    branch             = $r['branch']
    session_id         = $sid
    title              = $title
    agent              = $agent
    role               = $role
    calls              = [int]$r['calls']
    credits            = [double]$r['credits']
    session_credits_final = $final
    input_tokens       = [long]$r['input_tokens']
    cache_read_tokens  = [long]$r['cache_read_tokens']
    cache_write_tokens = [long]$r['cache_write_tokens']
    output_tokens      = [long]$r['output_tokens']
    reasoning_tokens   = [long]$r['reasoning_tokens']
    cache_hit_pct      = if ([long]$r['input_tokens'] -gt 0) { [math]::Round(100.0 * [long]$r['cache_read_tokens'] / [long]$r['input_tokens'], 0) } else { 0 }
    model_seconds      = [double]$r['model_seconds']
    models             = $r['models']
    reasoning_effort   = $r['reasoning_effort']
    user_requests      = $(if ($agent -eq '(main)') { $s.userRequests } else { '' })
    tool_calls         = $(if ($pa) { $pa.tools } else { 0 })
    tool_failures      = $(if ($pa) { $pa.fails } else { 0 })
    context_peak_pct   = $r['context_peak_pct']
    ended              = $s.ended
    first_call_local   = $firstLocal.ToString('yyyy-MM-dd HH:mm:ss')
    first_call_utc     = $r['first_call_utc']
    last_call_utc      = $r['last_call_utc']
    cwd                = $r['cwd']
  }
})

# --- セッションごとの記録(Markdown) ---
function Role([hashtable]$roles, $aid) { if (-not $aid) { return $null } if ($roles.ContainsKey([string]$aid)) { return $roles[[string]$aid] } return 'サブエージェント' }
function T($ts) { try { return ([datetime]$ts).ToLocalTime().ToString('HH:mm:ss') } catch { return '' } }

function Write-SessionRecord($sid, $s, $recs) {
  $main = $recs | Where-Object { $_.agent -eq '(main)' } | Select-Object -First 1
  if (-not $main) { $main = $recs[0] }
  $start = [datetime]::ParseExact($main.first_call_local, 'yyyy-MM-dd HH:mm:ss', $null)
  $dir = Join-Path $OutDir ('sessions\' + $start.ToString('yyyy-MM-dd'))
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $file = Join-Path $dir ($start.ToString('HHmm') + '_' + $sid.Substring(0, 8) + '.md')
  $before = $script:suspectCount
  $script:suspectKinds = @{}
  $sb = New-Object System.Text.StringBuilder
  $total = [math]::Round(($recs | Measure-Object credits -Sum).Sum, 4)
  [void]$sb.AppendLine('# ' + (OneLine $main.title 120))
  [void]$sb.AppendLine()
  $rowsMeta = @(
    @('セッション ID', $sid), @('種別', $main.source), @('リポジトリ / ブランチ', ('{0} / {1}' -f $main.repo, $main.branch)),
    @('作業フォルダ', $main.cwd), @('開始(現地時刻)', $main.first_call_local), @('最後の呼び出し(UTC)', ($recs | Sort-Object last_call_utc | Select-Object -Last 1).last_call_utc),
    @('Copilot の版', $(if ($s.meta) { G $s.meta 'copilotVersion' } else { '' })), @('最初のモデル / 推論強度', $(if ($s.meta) { ('{0} / {1}' -f (G $s.meta 'selectedModel'), (G $s.meta 'reasoningEffort')) } else { '' })),
    @('セッションの役', $s.mainRole), @('依頼の回数', $s.userRequests), @('使ったスキル', (($s.skills | Select-Object -Unique) -join ', ')),
    @('クレジット(呼び出しの合計)', $total), @('クレジット(終了時の確定値)', $main.session_credits_final),
    @('終わり方', $(switch ($s.ended) { 'shutdown' { '正常に終了(確定値あり)' } 'no-shutdown' { '確定値なし(実行中か、ウィンドウを閉じて終了)' } default { '経過の記録なし' } })),
    @('コンテキスト最大使用率', $(if ($main.context_peak_pct) { "$($main.context_peak_pct)%" } else { '' }))
  )
  [void]$sb.AppendLine('| 項目 | 値 |'); [void]$sb.AppendLine('| --- | --- |')
  foreach ($m in $rowsMeta) { [void]$sb.AppendLine('| ' + $m[0] + ' | ' + ((Scan ([string]$m[1])) -replace '\|', '\|') + ' |') }
  [void]$sb.AppendLine()
  [void]$sb.AppendLine('## 役ごとの消費'); [void]$sb.AppendLine()
  [void]$sb.AppendLine('| 役 | モデル | 呼び出し | クレジット | 入力 | うちキャッシュ読み | 出力 | 推論 | ツール | 失敗 | モデル時間(秒) |')
  [void]$sb.AppendLine('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  foreach ($x in $recs) { [void]$sb.AppendLine(('| {0} | {1} | {2} | {3} | {4} | {5} | {6} | {7} | {8} | {9} | {10} |' -f $x.role, $x.models, $x.calls, $x.credits, $x.input_tokens, $x.cache_read_tokens, $x.output_tokens, $x.reasoning_tokens, $x.tool_calls, $x.tool_failures, $x.model_seconds)) }
  [void]$sb.AppendLine()
  [void]$sb.AppendLine('## 経過'); [void]$sb.AppendLine()
  if (-not $s.exists) { [void]$sb.AppendLine('(このセッションの events.jsonl が無いので、経過は出せない。使用量だけ上の表に出している)') }
  $n = 0
  foreach ($it in $s.items) {
    $who = Role $s.roles $it.agent
    $tag = if ($who) { "[$who] " } else { '' }
    switch ($it.k) {
      'user' {
        $n++
        $h = if ($it.auto) { "### 依頼 $n(自動継続)" } else { "### 依頼 $n" }
        [void]$sb.AppendLine("$h — $(T $it.ts)"); [void]$sb.AppendLine()
        if ($it.attachments -gt 0) { [void]$sb.AppendLine("添付 $($it.attachments) 件"); [void]$sb.AppendLine() }
        [void]$sb.AppendLine((Fence (Scan $it.text) 'text')); [void]$sb.AppendLine()
      }
      'assistant' {
        if ($it.text -and $it.text.Trim()) {
          [void]$sb.AppendLine()
          [void]$sb.AppendLine("**$($tag)応答** — $(T $it.ts)($($it.model))"); [void]$sb.AppendLine()
          [void]$sb.AppendLine((Scan $it.text).Trim()); [void]$sb.AppendLine()
        }
      }
      'tool' {
        $mark = if ($null -eq $it.ok) { '…' } elseif ($it.ok) { '成功' } else { '**失敗**' }
        $sec = if ($null -ne $it.sec) { " $($it.sec) 秒" } else { '' }
        [void]$sb.AppendLine(('- {0} {1}`{2}` {3} — {4}{5}' -f (T $it.ts), $tag, $it.name, ((Scan $it.args) -replace '`', "'"), $mark, $sec))
        if ($it.err) { [void]$sb.AppendLine('  - エラー: ' + (OneLine (Scan $it.err) 400)) }
        $show = ($ToolOutput -eq 'all') -or ($ToolOutput -eq 'fail' -and $it.ok -eq $false)
        if ($it.name -eq 'task') {
          if ($it.prompt) { [void]$sb.AppendLine(); [void]$sb.AppendLine('<details><summary>委譲の指示</summary>'); [void]$sb.AppendLine(); [void]$sb.AppendLine((Fence (Cap (Scan $it.prompt) 8000) 'text')); [void]$sb.AppendLine(); [void]$sb.AppendLine('</details>') }
          if ($it.result) { [void]$sb.AppendLine(); [void]$sb.AppendLine('<details><summary>サブエージェントの報告</summary>'); [void]$sb.AppendLine(); [void]$sb.AppendLine((Fence (Cap (Scan $it.result) 8000) 'text')); [void]$sb.AppendLine(); [void]$sb.AppendLine('</details>'); [void]$sb.AppendLine() }
        } elseif ($show -and $it.result) {
          [void]$sb.AppendLine(); [void]$sb.AppendLine('<details><summary>結果</summary>'); [void]$sb.AppendLine(); [void]$sb.AppendLine((Fence (Cap (Scan $it.result) 3000) 'text')); [void]$sb.AppendLine(); [void]$sb.AppendLine('</details>'); [void]$sb.AppendLine()
        }
      }
      'substart' { [void]$sb.AppendLine(); [void]$sb.AppendLine(('#### サブエージェント開始: {0} — {1}(モデル {2}、種類 {3}、モデルの決まり方 {4})' -f $it.name, (T $it.ts), $it.model, $it.type, $it.source)); [void]$sb.AppendLine() }
      'subend' { [void]$sb.AppendLine(('- {0} **サブエージェント完了: {1}** — ツール {2} 回、{3} トークン、{4} 秒' -f (T $it.ts), $it.name, $it.toolCalls, $it.tokens, [math]::Round([double]$it.ms / 1000, 1))); [void]$sb.AppendLine() }
      'note' { [void]$sb.AppendLine(('- {0} {1}{2}' -f (T $it.ts), $tag, (Scan $it.text))) }
    }
  }
  if ($s.shutdown) {
    $sd = $s.shutdown; $cc = G $sd 'codeChanges'
    [void]$sb.AppendLine(); [void]$sb.AppendLine('## 終了時の記録'); [void]$sb.AppendLine()
    [void]$sb.AppendLine(('- 終わり方: {0} / プレミアムリクエスト換算: {1} / API 時間: {2} 秒' -f (G $sd 'shutdownType'), (G $sd 'totalPremiumRequests'), [math]::Round([double](G $sd 'totalApiDurationMs') / 1000, 1)))
    if ($cc) {
      $files = @(G $cc 'filesModified' | Where-Object { $_ })
      [void]$sb.AppendLine(('- コードの変更: +{0} -{1}、{2} ファイル' -f (G $cc 'linesAdded'), (G $cc 'linesRemoved'), $files.Count))
      foreach ($fm in $files) { [void]$sb.AppendLine('  - ' + (Scan ([string]$fm))) }
    }
  }
  [void]$sb.AppendLine()
  $sus = $script:suspectCount - $before
  $kinds = ($script:suspectKinds.Keys | Sort-Object) -join '、'
  # 書き出した時刻は入れない(中身が同じなら同じファイルになる)
  [void]$sb.AppendLine("---`ncopilot-usage-export / ツールの結果: $ToolOutput / 秘密情報の疑い: $sus 箇所$(if ($sus) { "($kinds)" }) / 読めなかった行: $($s.unparsed)")
  [IO.File]::WriteAllText($file, $sb.ToString(), (New-Object Text.UTF8Encoding($false)))
  if ($sus -gt 0) { $script:suspectFiles += ('{0}({1} 箇所: {2})' -f $file, $sus, $kinds) }
  return $file
}

# --- -Format cli の書き出し(Copilot CLI 1.0.100 の /share file と同じ組み立て) ---
function CliEsc([string]$s) {
  # コードの外にある < を \< にする(Markdown の HTML として解釈させない)。コードブロックとインラインコードはそのまま
  if (-not $s) { return '' }
  $s = $s -replace "`r`n?", "`n"
  if (-not $s.Contains('<')) { return $s }
  $ev = [System.Text.RegularExpressions.MatchEvaluator] { param($m) ($m.Groups[1].Value * 2) + '\<' }
  $out = New-Object System.Collections.Generic.List[string]
  $fence = $null
  foreach ($line in $s.Split("`n")) {
    $fm = [regex]::Match($line, '^ {0,3}(`{3,}|~{3,})')
    if ($fence) {
      if ($fm.Success -and $fm.Groups[1].Value[0] -eq $fence[0] -and $fm.Groups[1].Value.Length -ge $fence.Length) { $fence = $null }
      $out.Add($line); continue
    }
    if ($fm.Success) { $fence = $fm.Groups[1].Value; $out.Add($line); continue }
    # インラインコード: 同じ長さのバッククォートの並びで閉じる範囲
    $sb = New-Object System.Text.StringBuilder
    $pos = 0
    $runs = @([regex]::Matches($line, '`+'))
    $i = 0
    while ($i -lt $runs.Count) {
      $open = $runs[$i]; $j = $i + 1
      while ($j -lt $runs.Count -and $runs[$j].Length -ne $open.Length) { $j++ }
      if ($j -ge $runs.Count) { $i++; continue }
      $close = $runs[$j]
      [void]$sb.Append([regex]::Replace($line.Substring($pos, $open.Index - $pos), '(\\*)<', $ev))
      [void]$sb.Append($line.Substring($open.Index, $close.Index + $close.Length - $open.Index))
      $pos = $close.Index + $close.Length; $i = $j + 1
    }
    [void]$sb.Append([regex]::Replace($line.Substring($pos), '(\\*)<', $ev))
    $out.Add($sb.ToString())
  }
  return ($out -join "`n")
}
function CliFence([string]$s, [string]$lang = '') {
  $max = 0
  foreach ($m in [regex]::Matches($s, '`+')) { if ($m.Length -gt $max) { $max = $m.Length } }
  $f = '`' * [math]::Max(3, $max + 1)
  return "$f$lang`n$s`n$f"
}
function CliJsonStr([string]$s) {
  $sb = New-Object System.Text.StringBuilder; [void]$sb.Append('"')
  foreach ($ch in $s.ToCharArray()) {
    switch ([int]$ch) {
      0x22 { [void]$sb.Append('\"') } 0x5C { [void]$sb.Append('\\') } 0x08 { [void]$sb.Append('\b') } 0x0C { [void]$sb.Append('\f') }
      0x0A { [void]$sb.Append('\n') } 0x0D { [void]$sb.Append('\r') } 0x09 { [void]$sb.Append('\t') }
      default { if ([int]$ch -lt 0x20) { [void]$sb.Append(('\u{0:x4}' -f [int]$ch)) } else { [void]$sb.Append($ch) } }
    }
  }
  [void]$sb.Append('"'); return $sb.ToString()
}
function CliJson($v, [string]$ind = '') {
  # JSON.stringify(v, null, 2) と同じ形
  if ($null -eq $v) { return 'null' }
  if ($v -is [string]) { return CliJsonStr $v }
  if ($v -is [bool]) { if ($v) { return 'true' } return 'false' }
  $in = $ind + '  '
  if ($v -is [System.Collections.IDictionary]) {
    if ($v.Count -eq 0) { return '{}' }
    $parts = @(foreach ($k in $v.Keys) { $in + (CliJsonStr ([string]$k)) + ': ' + (CliJson $v[$k] $in) })
    return "{`n" + ($parts -join ",`n") + "`n$ind}"
  }
  if ($v -is [System.Collections.IEnumerable]) {
    $parts = @(foreach ($x in $v) { $in + (CliJson $x $in) })
    if ($parts.Count -eq 0) { return '[]' }
    return "[`n" + ($parts -join ",`n") + "`n$ind]"
  }
  if ($v -is [decimal] -or $v -is [double]) { if ($v -eq [math]::Truncate($v)) { return ([decimal]$v).ToString('0', [Globalization.CultureInfo]::InvariantCulture) } return $v.ToString([Globalization.CultureInfo]::InvariantCulture) }
  return [string]$v
}
function CliRel([string]$p, [string]$cwd) {
  if (-not $p -or -not [IO.Path]::IsPathRooted($p) -or -not $cwd) { return $p }
  if ($p -eq $cwd) { return '.' }
  foreach ($sep in @('\', '/')) { $c = $cwd.TrimEnd('\', '/') + $sep; if ($p.StartsWith($c)) { return $p.Substring($c.Length) } }
  return $p
}
function CliPaths($a, [string]$cwd) {
  $ps = @(G $a 'paths' | Where-Object { $_ -is [string] -and $_ }); if (-not $ps) { $ps = @(G $a 'path' | Where-Object { $_ -is [string] -and $_ }) }
  $r = @($ps | ForEach-Object { CliRel $_ $cwd } | Where-Object { $_ -ne '.' })
  if ($r) { return $r -join ', ' } return $null
}
function CliArgLine([string]$name, $a, [string]$cwd) {
  # 引数を 1 行で表せるツール(grep・glob・bash・view・edit・create)だけ。他は JSON を折りたたんで出す
  if (-not ($a -is [System.Collections.IDictionary])) { return $null }
  switch ($name) {
    { $_ -in @('grep', 'rg') } {
      $r = @('"' + (G $a 'pattern') + '"')
      if (G $a 'glob') { $r += 'in ' + (G $a 'glob') } elseif (G $a 'type') { $r += 'in ' + (G $a 'type') + ' files' }
      $pp = CliPaths $a $cwd; if ($pp) { $r += "($pp)" }
      return $r -join ' '
    }
    'glob' { $r = @('"' + (G $a 'pattern') + '"'); $pp = CliPaths $a $cwd; if ($pp) { $r += "in $pp" }; return $r -join ' ' }
    { $_ -in @('bash', 'local_shell') } { return '$ ' + (G $a 'command') }
    'view' {
      $vp = G $a 'path'; if (-not ($vp -is [string])) { return $null }
      $vr = @(G $a 'view_range')
      if ($vr.Count -gt 0 -and $null -ne $vr[0]) { $e2 = if ($vr.Count -gt 1 -and $vr[1] -ne -1) { $vr[1] } else { 'end' }; return "$vp (lines $($vr[0])-$e2)" }
      return $vp
    }
    { $_ -in @('edit', 'create') } { return (G $a 'path') }
  }
  return $null
}
function CliOutLabel([string]$log, [string]$name) {
  $ls = @($log.Split("`n") | Where-Object { $_.Trim() })
  $n = $ls.Count
  if ($n -eq 0) { return 'No output' }
  if ($name -in @('grep', 'rg', 'glob')) { return "$n $(if ($n -eq 1) { 'match' } else { 'matches' })" }
  if ($name -in @('view', 'bash', 'local_shell')) { return "$n line$(if ($n -ne 1) { 's' })" }
  if ($n -eq 1) { if ($ls[0].Length -le 60) { return $ls[0] } return $ls[0].Substring(0, 57) + '...' }
  return "$n lines"
}
function CliTool($x, [string]$cwd) {
  $h = '### `' + $x.name + '`'
  if ($x.done -and $x.rtype -eq 'failure') { $h += ' — Failed' }
  if ($x.intent) { $h += "`n`n**$($x.intent)**" }
  $line = if ($null -ne $x.args) { CliArgLine $x.name $x.args $cwd } else { $null }
  if ($line) { $h += "`n`n$line" }
  elseif ($null -ne $x.args) { $h += "`n`n<details>`n<summary>Arguments</summary>`n`n" + (CliFence (CliJson $x.args) 'json') + "`n`n</details>" }
  $h += "`n`n"
  if ($x.done -and $x.log) {
    $log = $x.log
    $diff = $log.Contains('diff --git') -or ($log.Contains('@@') -and ($log.Contains('+++') -or $log.Contains('---')))
    $lang = if ($diff) { 'diff' } else { '' }
    $hasDetails = $log -match '</details>|<details|</summary>|<summary'
    if ($log.Split("`n").Count -gt 5 -and -not $hasDetails) {
      $h += "<details>`n<summary>$(CliOutLabel $log $x.name)</summary>`n`n" + (CliFence $log.TrimEnd() $lang) + "`n`n</details>`n`n"
    } else { $h += (CliFence $log $lang) + "`n`n" }
  }
  return $h
}
function CliEntry($x, [string]$cwd) {
  switch ($x.k) {
    'user' { return "### User`n`n$(CliEsc $x.text)`n" }
    'copilot' { return "### Copilot`n`n$(CliEsc $x.text)`n" }
    'error' { return "### Error`n`n$(CliEsc $x.text)`n" }
    'info' { return "### Info`n`n$(CliEsc $x.text)`n" }
    'warning' { return "### Warning`n`n$(CliEsc $x.text)`n" }
    'compaction' { return "### ◌ Conversation Compacted`n" }
    'task' { return "### ✓ Task Complete`n`n$($x.text)`n" }
    'notice' { $r = "### Notification`n`n$($x.text)`n"; if ($x.detail) { $r += "`n<details>`n<summary>Detail</summary>`n`n$($x.detail)`n`n</details>`n" }; return $r }
    'tool' { return CliTool $x $cwd }
    'group' {
      $title = if ($x.title) { $x.title } else { $x.name }
      $inner = @(foreach ($c in $x.children) { CliEntry $c $cwd }) -join "`n"
      return "### $title$(if ($x.done) { ' (Completed)' })`n`n$inner`n"
    }
  }
  return ''
}
function CliClock([double]$sec) { $t = [math]::Floor($sec); if ($t -lt 60) { return "${t}s" } return ('{0}m {1}s' -f [math]::Floor($t / 60), ($t % 60)) }
function CliRedact([string]$s) {
  # CLI と同じく、接続トークン付きの wss:// URL と「Connection token:」の値を伏せる
  $s = [regex]::Replace($s, '\bwss?://[^\s"''<>`]*[^\s"''<>`.,;:)\]}]', [System.Text.RegularExpressions.MatchEvaluator] {
      param($m) $u = $m.Value
      if ($u -notmatch '[?&](?:tkn|token|access_token)=|^wss?://[^/?#]*@') { return $u }
      $u = $u -replace '^([a-z][a-z0-9+.-]*://)[^/?#]*@', '$1'
      $q = $u.IndexOf('?'); if ($q -ge 0) { $u = $u.Substring(0, $q) + '?…' }
      return $u
    }, 'IgnoreCase')
  return [regex]::Replace($s, '(\bConnection token:[ \t]*`?)[^\s<`"''>]+', '$1[REDACTED]', 'IgnoreCase')
}

function Write-CliRecord($sid, $s, $recs) {
  if (-not $s.exists) { return $null }
  $main = $recs | Where-Object { $_.agent -eq '(main)' } | Select-Object -First 1
  if (-not $main) { $main = $recs[0] }
  $day = [datetime]::ParseExact($main.first_call_local, 'yyyy-MM-dd HH:mm:ss', $null)
  $dir = Join-Path $OutDir ('cli\' + $day.ToString('yyyy-MM-dd'))
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $file = Join-Path $dir "copilot-session-$sid.md"
  $meta = $s.meta
  $cwd = if ($meta) { [string](G (G $meta 'context') 'cwd') } else { [string]$main.cwd }
  # 開始はセッションの開始時刻。所要時間は CLI では書き出した時点までだが、ここでは最後の出来事まで
  $startRaw = if ($meta -and (G $meta 'startTime')) { G $meta 'startTime' } elseif ($s.cli.Count) { $s.cli[0].ts } else { $main.first_call_utc }
  $start = ([datetime]$startRaw).ToUniversalTime()
  $last = if ($s.lastTs) { ([datetime]$s.lastTs).ToUniversalTime() } else { $start }
  $culture = Get-Culture
  $lines = @(
    '# Copilot CLI Session', '', '> [!NOTE]',
    ('> - **Session ID:** `' + $sid + '`  '),
    ('> - **Started:** ' + $start.ToLocalTime().ToString('G', $culture) + '  '),
    ('> - **Duration:** ' + (CliClock ($last - $start).TotalSeconds) + '  '),
    ('> - **Exported:** ' + (Get-Date).ToString('G', $culture) + '  '),
    '', '---', '', ''
  )
  $body = @(foreach ($x in $s.cli) {
    $rel = [math]::Max(0, (([datetime]$x.ts).ToUniversalTime() - $start).TotalSeconds)
    "<sub>$(CliClock $rel)</sub>`n`n" + (CliEntry $x $cwd)
  }) -join "`n---`n`n"
  $text = CliRedact (($lines -join "`n") + $body)
  $before = $script:suspectCount; $script:suspectKinds = @{}
  [void](Scan $text)
  $sus = $script:suspectCount - $before
  $kinds = ($script:suspectKinds.Keys | Sort-Object) -join '、'
  $text += "`n---`n`n<sub>copilot-usage-export が events.jsonl から書き出した(GitHub Copilot CLI の /share file と同じ形式) / 秘密情報の疑い: $sus 箇所$(if ($sus) { "($kinds)" }) / 読めなかった行: $($s.unparsed)</sub>`n"
  [IO.File]::WriteAllText($file, $text, (New-Object Text.UTF8Encoding($false)))
  if ($sus -gt 0) { $script:suspectFiles += ('{0}({1} 箇所: {2})' -f $file, $sus, $kinds) }
  return $file
}

# --- 書き出し ---
# 日ごとの CSV: 既存の行のうち今回出すセッションの行を差し替える
foreach ($g in ($records | Group-Object { $_.first_call_local.Substring(0, 10) })) {
  $dayFile = Join-Path $OutDir ("usage-$($g.Name).csv")
  $ids = @($g.Group | ForEach-Object { $_.session_id } | Select-Object -Unique)
  $keep = @()
  if (Test-Path $dayFile) { $keep = @(Import-Csv -LiteralPath $dayFile -Encoding UTF8 | Where-Object { $ids -notcontains $_.session_id }) }
  $all = @($keep) + @($g.Group) | Sort-Object first_call_utc, agent
  # 列は今回の形にそろえる(古い形の行は空欄で埋まる)
  $all | Select-Object -Property ($g.Group[0].PSObject.Properties.Name) | Export-Csv -Path $dayFile -NoTypeInformation -Encoding UTF8
}
$mdFiles = @()
$cliFiles = @()
$script:suspectFiles = @()
foreach ($g in ($records | Group-Object session_id)) {
  if ($wantRecord) { $mdFiles += Write-SessionRecord $g.Name $sessions[$g.Name] @($g.Group) }
  if ($wantCli) { $f = Write-CliRecord $g.Name $sessions[$g.Name] @($g.Group); if ($f) { $cliFiles += $f } }
}

if ($Raw) {
  $rawDir = Join-Path $OutDir 'raw'
  if (-not (Test-Path $rawDir)) { New-Item -ItemType Directory -Path $rawDir -Force | Out-Null }
  foreach ($sid in $sessions.Keys) { $p = Join-Path $stateDir "$sid\events.jsonl"; if (Test-Path $p) { Copy-Item -LiteralPath $p -Destination (Join-Path $rawDir "$sid.jsonl") -Force } }
}

# --- 画面にはセッション単位の要約 ---
$bySession = @($records | Group-Object session_id | ForEach-Object {
  $g = $_.Group; $m0 = ($g | Where-Object { $_.agent -eq '(main)' } | Select-Object -First 1); if (-not $m0) { $m0 = $g[0] }
  [pscustomobject]@{
    source  = $m0.source
    session = $m0.session_id.Substring(0, 8)
    title   = if ($m0.title) { $m0.title.Substring(0, [math]::Min(36, $m0.title.Length)) } else { '' }
    roles   = (($g | ForEach-Object { $_.role }) -join ',')
    credits = [math]::Round(($g | Measure-Object credits -Sum).Sum, 3)
    ended   = $m0.ended
    start   = $m0.first_call_local
  }
})
if (-not $Quiet) { $bySession | Format-Table -AutoSize | Out-String -Width 220 | Write-Host }
Say ("セッション {0} 件 / 行 {1} / 合計 {2} クレジット(Since={3} UTC)" -f $bySession.Count, $records.Count, [math]::Round(($records | Measure-Object credits -Sum).Sum, 3), $Since)
$outParts = @('日ごとの CSV')
if ($wantRecord) { $outParts += "sessions\ の Markdown $($mdFiles.Count) 件" }
if ($wantCli) { $outParts += "cli\ の Markdown(CLI 形式)$($cliFiles.Count) 件" }
Say "出力: $OutDir($($outParts -join ' と '))"
# 秘密情報の疑いは警告だけ出す(記録は書き換えない)
if ($script:suspectFiles.Count -gt 0) {
  Say ("警告: 秘密情報(API キー・トークンなど)らしき文字列が {0} 件の記録にある。中身を確認し、本物なら記録から消して鍵を作り直すこと。`n  {1}" -f $script:suspectFiles.Count, ($script:suspectFiles -join "`n  "))
}
exit 0
