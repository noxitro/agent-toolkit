// Copilot CLI の /export(= /share file)と同じ Markdown を、セッションのイベント列から組み立てる(副作用なし)。
// CLI はイベントから画面のタイムラインを組み、それを Markdown にする。ここではその 2 段をなぞる。
// 書式は Copilot CLI 1.0.100 の /export の出力と突き合わせて確かめた。CLI の版上げで形が変わることがある。
//
// CLI の書き出しと違うところ(記録に残らないもの): 画面にだけ出た表示(ヒント、シェルの途中出力、フックの進捗、画像)。

const HINTS = {
  sign_in: "Run /login to sign in again.",
  switch_account: "Run /user switch to use a different account.",
  show_account: "Run /user show to check which account is in use.",
  review_sandbox_policy: "Run /sandbox to review or widen the sandbox policy.",
  allow_sandbox_outbound: "Run /sandbox to allow outbound network access.",
  rewind_conversation: "Run /rewind to discard the blocked request before continuing.",
};
const hint = (msg, remediation) => {
  const h = typeof remediation === "string" ? HINTS[remediation] : null;
  if (!h) return msg;
  const t = String(msg ?? "").trimEnd();
  return t ? `${t} ${h}` : h;
};
const str = (v) => (v == null ? "" : String(v));

// --- 1 段目: イベント → タイムラインの項目 ---

function notice(kind, content) {
  const t = kind?.type;
  const desc = kind?.description;
  const agent = desc || kind?.agentId;
  const shell = desc ? `"${desc}"` : kind?.shellId;
  switch (t) {
    case "agent_completed":
      return [`Background agent "${agent}" (${kind.agentType}) ${kind.status === "completed" ? "completed" : "failed"}`, kind.prompt];
    case "shell_completed": {
      const ec = kind.exitCode;
      return [`Shell ${shell} ${ec == null || ec === 0 ? "completed" : `exited (code ${ec})`}`, null];
    }
    case "shell_detached_completed":
      return [`Detached shell ${shell} completed`, null];
    case "agent_idle":
      return [`Background agent "${agent}" (${kind.agentType}) completed.`, null];
    case "instruction_discovered":
      return [`Discovered ${desc || kind.sourcePath}`, null];
    case "workflow_completed": {
      const lines = [];
      if (kind.resultPreview) lines.push(`Result preview: ${kind.resultPreview}`);
      if (kind.failure != null) lines.push(`Failure: ${typeof kind.failure === "string" ? kind.failure : JSON.stringify(kind.failure)}`);
      if (kind.retryGuidance) lines.push(`Retry guidance: ${kind.retryGuidance}`);
      return [`Workflow "${kind.workflowName}" ${kind.status}`, lines.length ? lines.join("\n") : null];
    }
    default:
      return [content, null];
  }
}

// 完了時、計測値にモデル名があれば引数に model として足す(CLI と同じ)
function withModel(args, d) {
  const pr = d?.toolTelemetry?.properties;
  const m = pr?.resolved_model ?? pr?.model;
  if (typeof m !== "string" || !args || typeof args !== "object" || Array.isArray(args)) return args;
  return { ...args, model: m };
}

const abortTool = (x) => Object.assign(x, { done: true, rtype: "failure", log: "Operation aborted by user" });

export function buildTimeline(events) {
  const list = [];
  const idx = new Map(); // toolCallId → 項目
  const msgs = new Map(); // 親 toolCallId|messageId → 応答の項目
  // サブエージェントの最初の出力が届いたら、委譲したツールの項目をまとまり(group)に変える
  const group = (p) => {
    const x = idx.get(p);
    if (!x || x.nested) return null;
    if (x.k === "tool") Object.assign(x, { k: "group", children: [] });
    return x;
  };
  for (const e of events) {
    const d = e.data ?? {};
    const ts = e.timestamp;
    // サブエージェントの出来事は parentToolCallId(無ければ agentId)で委譲元のツールにつなぐ
    const p = str(d.parentToolCallId) || str(e.agentId) || str(d.agentId);
    switch (e.type) {
      case "user.message": {
        const src = str(d.source);
        const c = str(d.content);
        if (!p && c && (!src || src === "user" || /^(command-|schedule-|autopilot-)/.test(src))) list.push({ k: "user", ts, text: c });
        break;
      }
      case "assistant.message": {
        let box = list;
        if (p) {
          const g = group(p);
          if (!g) break;
          box = g.children;
        }
        const mk = `${p}|${str(d.messageId)}`;
        // 推論は本文とツールより前に置く(CLI の /export は本体の推論を出し、サブエージェントの推論は出さない)
        const rt = str(d.reasoningText);
        if (rt && !p) {
          if (msgs.has(`r|${mk}`)) msgs.get(`r|${mk}`).text = rt;
          else {
            const it = { k: "reasoning", ts, text: rt };
            msgs.set(`r|${mk}`, it);
            box.push(it);
          }
        }
        const c = str(d.content);
        if (c) {
          if (msgs.has(mk)) msgs.get(mk).text = c;
          else {
            const it = { k: "copilot", ts, text: c };
            msgs.set(mk, it);
            box.push(it);
          }
        }
        for (const r of d.toolRequests ?? []) {
          if (!r) continue;
          const cid = str(r.toolCallId);
          if (!p && idx.has(cid)) continue;
          const it = { k: "tool", ts, callId: cid, name: str(r.name), title: r.toolTitle, intent: r.intentionSummary, args: r.arguments, done: false, nested: !!p };
          idx.set(cid, it);
          box.push(it);
        }
        break;
      }
      case "tool.user_requested": {
        const cid = str(d.toolCallId);
        const name = str(d.toolName);
        const a0 = d.arguments;
        const title = name === "local_shell" && a0?.command ? `$ ${a0.command}` : null;
        const it = { k: "tool", ts, callId: cid, name, title, intent: null, args: a0, done: false, nested: false };
        idx.set(cid, it);
        list.push(it);
        break;
      }
      case "tool.execution_complete": {
        const x = idx.get(str(d.toolCallId));
        if (!x) break;
        x.done = true;
        x.args = withModel(x.args, d);
        if (x.k === "tool") {
          x.ts = ts;
          if (d.success) Object.assign(x, { rtype: "success", log: str(d.result?.content) });
          else Object.assign(x, { rtype: "failure", log: hint(str(d.error?.message), d.error?.remediation) });
        }
        break;
      }
      case "abort":
        if (p) break;
        for (const x of list) {
          if (x.done) continue;
          if (x.k === "tool") abortTool(x);
          else if (x.k === "group") {
            x.done = true;
            for (const c of x.children) if (c.k === "tool" && !c.done) abortTool(c);
          }
        }
        break;
      case "session.error":
        list.push({ k: "error", ts, text: hint(str(d.message), d.remediation) });
        break;
      case "session.info":
        if (d.infoType !== "file_created") list.push({ k: "info", ts, text: str(d.message) });
        break;
      case "session.warning":
        list.push({ k: "warning", ts, text: hint(str(d.message), d.remediation) });
        break;
      case "session.compaction_complete":
        if (d.success && !p) list.push({ k: "compaction", ts });
        break;
      case "session.task_complete":
        list.push({ k: "task", ts, text: str(d.summary) });
        break;
      case "system.notification": {
        if (d.kind?.type === "new_inbox_message") break;
        const [text, detail] = notice(d.kind, str(d.content));
        list.push({ k: "notice", ts, text, detail });
        break;
      }
    }
  }
  return list;
}

// --- 2 段目: タイムライン → Markdown ---

// コードの外にある < を \< にする(Markdown の HTML として解釈させない)。コードブロックとインラインコードはそのまま
function esc(s) {
  if (!s) return "";
  s = s.replace(/\r\n?/g, "\n");
  if (!s.includes("<")) return s;
  const lt = (t) => t.replace(/(\\*)</g, (_, bs) => bs + bs + "\\<");
  const out = [];
  let fence = null;
  for (const line of s.split("\n")) {
    const fm = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length) fence = null;
      out.push(line);
      continue;
    }
    if (fm) {
      fence = fm[1];
      out.push(line);
      continue;
    }
    // インラインコード: 同じ長さのバッククォートの並びで閉じる範囲
    const runs = [...line.matchAll(/`+/g)];
    let res = "";
    let pos = 0;
    let i = 0;
    while (i < runs.length) {
      const open = runs[i];
      let j = i + 1;
      while (j < runs.length && runs[j][0].length !== open[0].length) j++;
      if (j >= runs.length) {
        i++;
        continue;
      }
      const close = runs[j];
      res += lt(line.slice(pos, open.index)) + line.slice(open.index, close.index + close[0].length);
      pos = close.index + close[0].length;
      i = j + 1;
    }
    out.push(res + lt(line.slice(pos)));
  }
  return out.join("\n");
}

const fence = (s, lang = "") => {
  const max = Math.max(0, ...[...s.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(Math.max(3, max + 1));
  return `${f}${lang}\n${s}\n${f}`;
};

const isRooted = (p) => /^([a-zA-Z]:[\\/]|[\\/])/.test(p);
function rel(p, cwd) {
  if (!p || !isRooted(p) || !cwd) return p;
  if (p === cwd) return ".";
  for (const sep of ["\\", "/"]) {
    const c = cwd.replace(/[\\/]+$/, "") + sep;
    if (p.startsWith(c)) return p.slice(c.length);
  }
  return p;
}
function paths(a, cwd) {
  let ps = [a.paths].flat().filter((x) => typeof x === "string" && x);
  if (!ps.length) ps = [a.path].flat().filter((x) => typeof x === "string" && x);
  const r = ps.map((x) => rel(x, cwd)).filter((x) => x !== ".");
  return r.length ? r.join(", ") : null;
}

// 引数を 1 行で表せるツール(grep・glob・bash・view・edit・create)だけ。他は JSON を折りたたんで出す
function argLine(name, a, cwd) {
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  switch (name) {
    case "grep":
    case "rg": {
      const r = [`"${str(a.pattern)}"`];
      if (a.glob) r.push(`in ${a.glob}`);
      else if (a.type) r.push(`in ${a.type} files`);
      const pp = paths(a, cwd);
      if (pp) r.push(`(${pp})`);
      return r.join(" ");
    }
    case "glob": {
      const r = [`"${str(a.pattern)}"`];
      const pp = paths(a, cwd);
      if (pp) r.push(`in ${pp}`);
      return r.join(" ");
    }
    case "bash":
    case "local_shell":
      return `$ ${str(a.command)}`;
    case "view": {
      if (typeof a.path !== "string") return null;
      const vr = [a.view_range].flat();
      if (vr.length > 0 && vr[0] != null) return `${a.path} (lines ${vr[0]}-${vr.length > 1 && vr[1] !== -1 ? vr[1] : "end"})`;
      return a.path;
    }
    case "edit":
    case "create":
      return str(a.path);
  }
  return null;
}

function outLabel(log, name) {
  const ls = log.split("\n").filter((l) => l.trim());
  const n = ls.length;
  if (n === 0) return "No output";
  if (["grep", "rg", "glob"].includes(name)) return `${n} ${n === 1 ? "match" : "matches"}`;
  if (["view", "bash", "local_shell"].includes(name)) return `${n} line${n !== 1 ? "s" : ""}`;
  if (n === 1) return ls[0].length <= 60 ? ls[0] : ls[0].slice(0, 57) + "...";
  return `${n} lines`;
}

function toolEntry(x, cwd) {
  let h = `### \`${x.name}\``;
  if (x.done && x.rtype === "failure") h += " — Failed";
  if (x.intent) h += `\n\n**${x.intent}**`;
  const line = x.args != null ? argLine(x.name, x.args, cwd) : null;
  if (line) h += `\n\n${line}`;
  else if (x.args != null) h += `\n\n<details>\n<summary>Arguments</summary>\n\n${fence(JSON.stringify(x.args, null, 2), "json")}\n\n</details>`;
  h += "\n\n";
  if (x.done && x.log) {
    const log = x.log;
    const diff = log.includes("diff --git") || (log.includes("@@") && (log.includes("+++") || log.includes("---")));
    const lang = diff ? "diff" : "";
    const hasDetails = /<\/details>|<details|<\/summary>|<summary/.test(log);
    if (log.split("\n").length > 5 && !hasDetails) h += `<details>\n<summary>${outLabel(log, x.name)}</summary>\n\n${fence(log.trimEnd(), lang)}\n\n</details>\n\n`;
    else h += `${fence(log, lang)}\n\n`;
  }
  return h;
}

function entry(x, cwd) {
  switch (x.k) {
    case "user":
      return `### User\n\n${esc(x.text)}\n`;
    case "copilot":
      return `### Copilot\n\n${esc(x.text)}\n`;
    case "reasoning":
      return `### Reasoning\n\n*${esc(x.text)}*\n`;
    case "error":
      return `### Error\n\n${esc(x.text)}\n`;
    case "info":
      return `### Info\n\n${esc(x.text)}\n`;
    case "warning":
      return `### Warning\n\n${esc(x.text)}\n`;
    case "compaction":
      return "### ◌ Conversation Compacted\n";
    case "task":
      return `### ✓ Task Complete\n\n${x.text}\n`;
    case "notice": {
      let r = `### Notification\n\n${x.text}\n`;
      if (x.detail) r += `\n<details>\n<summary>Detail</summary>\n\n${x.detail}\n\n</details>\n`;
      return r;
    }
    case "tool":
      return toolEntry(x, cwd);
    case "group": {
      const inner = x.children.map((c) => entry(c, cwd)).join("\n");
      return `### ${x.title || x.name}${x.done ? " (Completed)" : ""}\n\n${inner}\n`;
    }
  }
  return "";
}

export function lastCwd(events) {
  let cwd = "";
  for (const e of events) {
    const c = e.data?.context?.cwd ?? (e.type === "session.context_changed" ? e.data?.cwd : undefined);
    if (typeof c === "string" && c) cwd = c;
  }
  return cwd;
}

const clock = (sec) => {
  const t = Math.floor(sec);
  return t < 60 ? `${t}s` : `${Math.floor(t / 60)}m ${t % 60}s`;
};

// CLI と同じく、接続トークン付きの wss:// URL と「Connection token:」の値を伏せる
function redact(s) {
  s = s.replace(/\bwss?:\/\/[^\s"'<>`]*[^\s"'<>`.,;:)\]}]/gi, (u) => {
    if (!/[?&](?:tkn|token|access_token)=|^wss?:\/\/[^/?#]*@/i.test(u)) return u;
    u = u.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, "$1");
    const q = u.indexOf("?");
    return q >= 0 ? u.slice(0, q) + "?…" : u;
  });
  return s.replace(/(\bConnection token:[ \t]*`?)[^\s<`"'>]+/gi, "$1[REDACTED]");
}

// cwd はパスを相対にする基準。CLI は書き出す時点の作業フォルダを使うので、呼び出し側が渡す
// (省略すると、記録にある最後の作業フォルダ)
export function renderCliExport({ events, sessionId, now = new Date(), cwd }) {
  const startEv = events.find((e) => e.type === "session.start")?.data ?? {};
  const list = buildTimeline(events);
  cwd ??= lastCwd(events);
  const start = new Date(startEv.startTime ?? list[0]?.ts ?? events[0]?.timestamp ?? now);
  const head = [
    "# Copilot CLI Session",
    "",
    "> [!NOTE]",
    `> - **Session ID:** \`${sessionId ?? startEv.sessionId ?? ""}\`  `,
    `> - **Started:** ${start.toLocaleString()}  `,
    `> - **Duration:** ${clock((now - start) / 1000)}  `,
    `> - **Exported:** ${now.toLocaleString()}  `,
    "",
    "---",
    "",
    "",
  ].join("\n");
  const body = list.map((x) => `<sub>${clock(Math.max(0, (new Date(x.ts) - start) / 1000))}</sub>\n\n${entry(x, cwd)}`).join("\n---\n\n");
  return redact(head + body) + "\n---\n\n<sub>Generated by [GitHub Copilot CLI](https://github.com/features/copilot/cli)</sub>\n";
}

// 引数なし → 作業フォルダの copilot-session-<ID>.md(CLI の /export file と同じ)。フォルダ → その中に同じ名前。
// .md → そのファイル。相対パスはセッションの作業フォルダから解決する
export function cliOutputPath(arg, cwd, sessionId, { resolve, join, isAbsolute }) {
  const name = `copilot-session-${sessionId}.md`;
  const a = str(arg).trim().replace(/^["']|["']$/g, "");
  if (!a) return join(cwd, name);
  const p = isAbsolute(a) ? a : resolve(cwd, a);
  return /\.md$/i.test(p) ? p : join(p, name);
}
