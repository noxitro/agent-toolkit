// node --test tools/copilot-session-export/test で走らせる。合成したイベント列で描画の規則を確かめる
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import { test } from "node:test";
import { outputPath, renderSession } from "../plugin/extensions/session-export/render.mjs";

const cwd = join(homedir(), "work", "repo");
const ev = (type, data, extra = {}) => ({ type, data, id: Math.random().toString(36).slice(2), timestamp: "2026-10-22T01:00:00.000Z", ...extra });
const events = [
  ev("session.start", { sessionId: "abcdef12-0000-0000-0000-000000000000", copilotVersion: "1.0.99", startTime: "2026-10-22T01:00:00.000Z", context: { cwd } }),
  ev("session.model_change", { newModel: "model-a", reasoningEffort: "medium" }),
  ev("user.message", { content: "README を直して" }),
  ev("user.message", { content: "<system_reminder>自動の指示</system_reminder>", source: "instruction-discovery" }),
  ev("assistant.message", { content: "直します。" }),
  ev("tool.execution_start", { toolCallId: "t0", toolName: "report_intent", arguments: { intent: "見出し" } }),
  ev("tool.execution_start", { toolCallId: "t1", toolName: "view", arguments: { path: join(cwd, "README.md") } }),
  ev("tool.execution_complete", { toolCallId: "t1", success: true, result: { content: "本文" } }),
  ev("tool.execution_start", { toolCallId: "t2", toolName: "task", arguments: { description: "調べる", prompt: "調べて" } }),
  ev("subagent.started", { toolCallId: "t2", agentName: "explore", agentDisplayName: "Explore", model: "model-b" }, { agentId: "ag1" }),
  ev("user.message", { content: "調べて" }, { agentId: "ag1" }),
  ev("tool.execution_start", { toolCallId: "t3", toolName: "rg", arguments: { pattern: "foo" } }, { agentId: "ag1" }),
  ev("tool.execution_complete", { toolCallId: "t3", success: false, error: { message: "見つからない" } }, { agentId: "ag1" }),
  ev("assistant.message", { content: "委譲先の途中の発言" }, { agentId: "ag1" }),
  ev("subagent.completed", { toolCallId: "t2", agentName: "explore", agentDisplayName: "Explore", totalToolCalls: 1, durationMs: 1500 }, { agentId: "ag1" }),
  ev("tool.execution_complete", { toolCallId: "t2", success: true, result: { content: "報告に ``` を含む" } }),
];
const metrics = {
  totalNanoAiu: 1.5e9, totalUserRequests: 1, totalPremiumRequestCost: 1, totalApiDurationMs: 2000,
  agentMetrics: { main: { modelMetrics: { "model-a": { requests: { count: 2 }, totalNanoAiu: 1e9, usage: { inputTokens: 1000, outputTokens: 10 } } } } },
};

test("人の依頼だけを数え、自動で差し込まれた指示と委譲の指示は出さない", () => {
  const md = renderSession({ events, metrics, sessionId: "abcdef12" });
  assert.match(md, /### 依頼 1 — /);
  assert.doesNotMatch(md, /依頼 2/);
  assert.doesNotMatch(md, /system_reminder/);
  assert.doesNotMatch(md, /委譲先の途中の発言/);
});

test("ツールは 1 行ずつ、作業フォルダの中のパスは相対、失敗は理由付き、report_intent は出さない", () => {
  const md = renderSession({ events, metrics, sessionId: "abcdef12" });
  assert.match(md, /- `view` README\.md — 成功/);
  assert.match(md, /- \[Explore\] `rg` foo — \*\*失敗\*\*.*見つからない/);
  assert.doesNotMatch(md, /report_intent/);
});

test("委譲先の報告は折りたたみで全文を残し、中の ``` で柵が閉じない", () => {
  const md = renderSession({ events, metrics, sessionId: "abcdef12" });
  assert.match(md, /<summary>委譲先の報告<\/summary>/);
  assert.match(md, /````\n {2}報告に ``` を含む\n {2}````/);
});

test("使用量は役とモデルごとの行、クレジットは nano AIU から換算", () => {
  const md = renderSession({ events, metrics, sessionId: "abcdef12" });
  assert.match(md, /AI クレジット: 1\.50/);
  assert.match(md, /\| main \| model-a \| 2 \| 1\.00 \| 1,000 \|/);
  assert.match(renderSession({ events, metrics: null, sessionId: "x" }), /使用量を取得できなかった/);
});

test("出力先: 引数なしは ~/copilot-sessions/<日付>/、フォルダ指定はその中、.md はそのまま", () => {
  const now = new Date(2026, 9, 22, 3, 4, 5);
  assert.equal(outputPath("", cwd, "abcdef12-xxxx", now), join(homedir(), "copilot-sessions", "2026-10-22", "030405_abcdef12.md"));
  assert.equal(outputPath("logs", cwd, "abcdef12-xxxx", now), join(cwd, "logs", "030405_abcdef12.md"));
  assert.equal(outputPath('"out/a.md"', cwd, "abcdef12-xxxx", now), join(cwd, "out", "a.md"));
});
