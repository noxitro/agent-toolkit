// セッションのイベント列と使用量から Markdown を組み立てる(副作用なし。拡張と検査スクリプトの両方から使う)。
// イベントは session.getEvents() と ~/.copilot/session-state/<ID>/events.jsonl の 1 行と同じ形。
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const pad = (n, w = 2) => String(n).padStart(w, "0");
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const stamp = (iso) => (iso ? `${localDate(new Date(iso))} ${localTime(new Date(iso))}` : "");
const clock = (iso) => (iso ? localTime(new Date(iso)) : "");
const credits = (nano) => (typeof nano === "number" ? (nano / 1e9).toFixed(2) : "");
const num = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : "");
const seconds = (ms) => `${((ms ?? 0) / 1000).toFixed(1)} 秒`;
const oneLine = (s, max = 120) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};
// 中身に ``` があっても閉じないよう、柵を中身の最長より 1 本長くする
const fence = (text) => {
  const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}\n${text}\n${f}`;
};

// ツールの引数から、何をしたか分かる 1 項目だけを選ぶ。作業フォルダの中のパスは相対にする
const ARG_KEYS = ["path", "file_path", "command", "pattern", "query", "url", "description", "prompt"];
function argSummary(args, cwd) {
  if (!args || typeof args !== "object") return oneLine(args ?? "");
  const key = ARG_KEYS.find((k) => typeof args[k] === "string" && args[k]);
  let v = key ? args[key] : Object.values(args).find((x) => typeof x === "string") ?? "";
  if ((key === "path" || key === "file_path") && cwd && isAbsolute(v)) {
    const r = relative(cwd, v);
    if (r && !r.startsWith("..") && !isAbsolute(r)) v = r;
  }
  return oneLine(v);
}

function usageSection(m) {
  if (!m) return ["## 使用量", "", "(使用量を取得できなかった)", ""];
  const out = ["## 使用量(書き出した時点)", ""];
  out.push(`- AI クレジット: ${credits(m.totalNanoAiu)}(状態: ${m.aiCreditsStatus ?? "不明"})`);
  out.push(`- 依頼の回数: ${num(m.totalUserRequests)} / プレミアムリクエスト換算: ${m.totalPremiumRequestCost ?? ""}`);
  out.push(`- モデルの応答時間の合計: ${seconds(m.totalApiDurationMs)}`);
  const cc = m.codeChanges;
  if (cc?.filesModifiedCount) out.push(`- 変更: ${cc.filesModifiedCount} ファイル(+${cc.linesAdded} / -${cc.linesRemoved})`);
  out.push("", "| 役 | モデル | 呼び出し | AI クレジット | 入力 | キャッシュ読み | キャッシュ書き | 出力 | 推論 |");
  out.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  const roles = m.agentMetrics && Object.keys(m.agentMetrics).length ? m.agentMetrics : { main: { modelMetrics: m.modelMetrics } };
  for (const [role, a] of Object.entries(roles)) {
    for (const [model, mm] of Object.entries(a.modelMetrics ?? {})) {
      const u = mm.usage ?? {};
      out.push(`| ${role} | ${model} | ${num(mm.requests?.count)} | ${credits(mm.totalNanoAiu)} | ${num(u.inputTokens)} | ${num(u.cacheReadTokens)} | ${num(u.cacheWriteTokens)} | ${num(u.outputTokens)} | ${num(u.reasoningTokens)} |`);
    }
  }
  out.push("");
  return out;
}

// 経過は「ブロック」の列として組み、最後に連結する。ツールの行は完了時に書き換えるので参照を持つ
function timelineSection(events, cwd) {
  const blocks = [];
  const tools = new Map(); // toolCallId → { block, start, name }
  const agents = new Map(); // agentId / 委譲した toolCallId → サブエージェント名
  let request = 0;
  const heading = (text) => blocks.push({ kind: "heading", text });
  const item = (text) => {
    const b = { kind: "item", text, detail: null };
    blocks.push(b);
    return b;
  };
  const who = (e) => {
    const id = e.agentId ?? e.data?.parentToolCallId;
    return id ? agents.get(id) ?? "サブエージェント" : null;
  };
  for (const e of events) {
    const d = e.data ?? {};
    switch (e.type) {
      case "user.message":
        if (e.agentId || d.parentToolCallId) break; // 委譲の指示は task ツールの行に出る
        // 人が打った依頼だけを出す(指示ファイルの自動差し込みなど、source 付きの合成メッセージは除く)
        if (d.source && d.source !== "user" && !/^(command-|schedule-|autopilot-)/.test(d.source)) break;
        request++;
        heading(`### 依頼 ${request} — ${clock(e.timestamp)}`);
        blocks.push({ kind: "text", text: d.content ?? "" });
        break;
      case "assistant.message":
        if (d.content && !who(e)) {
          heading(`#### Copilot — ${clock(e.timestamp)}`);
          blocks.push({ kind: "text", text: d.content });
        }
        break;
      case "tool.execution_start": {
        if (d.toolName === "report_intent") break; // 画面の見出し用で、作業ではない
        const sub = who(e);
        const text = `${sub ? `[${sub}] ` : ""}\`${d.toolName}\` ${argSummary(d.arguments, cwd)}`.trimEnd();
        tools.set(d.toolCallId, { block: item(text + " — 結果なし"), base: text, start: e.timestamp, name: d.toolName });
        break;
      }
      case "tool.execution_complete": {
        const t = tools.get(d.toolCallId);
        if (!t) break;
        const sec = t.start ? `(${seconds(new Date(e.timestamp) - new Date(t.start))})` : "";
        if (d.success) {
          t.block.text = `${t.base} — 成功${sec}`;
          // 委譲先の報告は全文を残す(task ツールの結果)
          if (t.name === "task" && d.result?.content) t.block.detail = { summary: "委譲先の報告", body: d.result.content };
        } else {
          t.block.text = `${t.base} — **失敗**${sec}: ${oneLine(d.error?.message ?? "", 200)}`;
        }
        break;
      }
      case "subagent.started": {
        const name = d.agentDisplayName || d.agentName;
        if (e.agentId) agents.set(e.agentId, name);
        if (d.toolCallId) agents.set(d.toolCallId, name);
        item(`サブエージェント開始: ${name}(${d.model ?? ""})`);
        break;
      }
      case "subagent.completed":
        item(`サブエージェント完了: ${d.agentDisplayName || d.agentName}(ツール ${num(d.totalToolCalls)} 回、${seconds(d.durationMs)})`);
        break;
      case "subagent.failed":
        item(`**サブエージェント失敗**: ${d.agentDisplayName || d.agentName} ${oneLine(d.error ?? d.message ?? "", 200)}`);
        break;
      case "session.model_change":
        item(d.previousModel ? `モデル変更: ${d.previousModel} → ${d.newModel}` : `モデル: ${d.newModel}${d.reasoningEffort ? `(${d.reasoningEffort})` : ""}`);
        break;
      case "skill.invoked":
        item(`スキル: ${d.name}`);
        break;
      case "session.error":
        item(`**エラー**: ${oneLine(d.message, 300)}`);
        break;
      case "abort":
        item(`**中断**: ${d.reason ?? ""}`);
        break;
      case "session.compaction_complete":
        if (d.success) item("会話を要約して文脈を詰めた");
        break;
    }
  }
  const out = ["## 経過", ""];
  if (request === 0) out.push("(まだ依頼が無い)", "");
  let inList = false;
  for (const b of blocks) {
    if (b.kind === "item") {
      out.push(`- ${b.text}`);
      inList = true;
      if (b.detail) {
        out.push("", `  <details><summary>${b.detail.summary}</summary>`, "", ...fence(b.detail.body).split("\n").map((l) => (l ? "  " + l : l)), "", "  </details>", "");
      }
      continue;
    }
    if (inList) out.push("");
    inList = false;
    out.push(b.text, "");
  }
  if (inList) out.push("");
  return out;
}

export function renderSession({ events, metrics, sessionId, now = new Date() }) {
  const start = events.find((e) => e.type === "session.start")?.data ?? {};
  const cwd = start.context?.cwd ?? "";
  return [
    "# Copilot セッション記録",
    "",
    "| 項目 | 値 |",
    "| --- | --- |",
    `| セッション ID | ${sessionId ?? start.sessionId ?? ""} |`,
    `| 作業フォルダ | ${cwd} |`,
    `| 開始 | ${stamp(start.startTime)} |`,
    `| 書き出し | ${localDate(now)} ${localTime(now)} |`,
    `| Copilot の版 | ${start.copilotVersion ?? ""} |`,
    "",
    ...usageSection(metrics),
    ...timelineSection(events, cwd),
    "---",
    "",
    "/save-session で書き出した。モデル内部の推論、成功したツールの結果(委譲先の報告を除く)、システムプロンプトは入れていない。",
    "",
  ].join("\n");
}

// 引数なし → ~/copilot-sessions/<日付>/<時刻>_<ID 8 桁>.md、フォルダ → その中に同じ名前、.md → そのファイル。
// 相対パスはセッションの作業フォルダから解決する
export function outputPath(args, cwd, sessionId, now = new Date()) {
  const name = `${localTime(now).replaceAll(":", "")}_${sessionId.slice(0, 8)}.md`;
  const a = String(args ?? "").trim().replace(/^["']|["']$/g, "");
  if (!a) return join(homedir(), "copilot-sessions", localDate(now), name);
  const p = isAbsolute(a) ? a : resolve(cwd || process.cwd(), a);
  return /\.md$/i.test(p) ? p : join(p, name);
}
