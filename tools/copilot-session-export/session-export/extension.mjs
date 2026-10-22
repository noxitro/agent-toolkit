// GitHub Copilot の拡張。モデルは呼ばない(セッションの記録をランタイムから読んでファイルに書くだけ)。
//
// /export [file] [session] [パス]  Copilot CLI の /export file と同じ Markdown を書き出す。
//                                   パスなし → 作業フォルダの copilot-session-<ID>.md、フォルダ → その中、.md → そのファイル。
//                                   Copilot CLI(ターミナル)では組み込みの /export が優先され、この拡張のものは出ない。
//                                   デスクトップ アプリなど、組み込みの /export が無いところで使う。
// /save-session [パス]             使用量(役 × モデルごとのクレジットとトークン)付きの記録を書き出す。
//                                   パスなし → ~/copilot-sessions/<日付>/<時刻>_<ID 8 桁>.md
//
// 相対パスはセッションの作業フォルダから解決する。
import { joinSession } from "@github/copilot-sdk/extension";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { cliOutputPath, lastCwd, renderCliExport } from "./render-cli.mjs";
import { outputPath, renderSession } from "./render.mjs";

// 結果の 1 行は記録に残さない(残すと、次に書き出したときに「Info」として載る)
const tell = (message, level) => session.log(message, { ephemeral: true, ...(level ? { level } : {}) });

function write(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
}

// 書き出した先を知らせる。デスクトップ アプリはセッションのログを画面に出さないので、
// ダイアログを出せるところでは確認ダイアログで知らせ、求められたらフォルダを開く(ダイアログは記録に残らない)
async function announce(message, file) {
  await tell(message);
  if (!session.capabilities?.ui?.elicitation) return;
  try {
    if (await session.ui.confirm(`${message}\nフォルダを開きますか?`)) openFolder(file);
  } catch {
    // ダイアログを出せなくても書き出しは済んでいる
  }
}

function openFolder(file) {
  const [cmd, args] =
    process.platform === "win32" ? ["explorer.exe", [`/select,${file}`]] : process.platform === "darwin" ? ["open", ["-R", file]] : ["xdg-open", [dirname(file)]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}

// CLI の /export は「file [session|research] [パス]」。ここでは file(と session)だけを受ける
function parseExportArgs(args) {
  const words = args.trim().split(/\s+/).filter(Boolean);
  const sub = words[0]?.toLowerCase();
  if (["html", "gist", "link", "off", "research"].includes(sub)) return { unsupported: sub };
  if (sub === "file") words.shift();
  if (words[0]?.toLowerCase() === "session") words.shift();
  return { path: words.join(" ") };
}

const session = await joinSession({
  commands: [
    {
      name: "export",
      description: "Copilot CLI の /export file と同じ Markdown にセッションを書き出す(モデルは呼ばない)。引数: [file] [パス]",
      handler: async (ctx) => {
        try {
          const a = parseExportArgs(ctx.args);
          if (a.unsupported) {
            await tell(`/export ${a.unsupported} には対応していない(この拡張は file だけ)。/export [file] [パス] で Markdown に書き出す。`, "warning");
            return;
          }
          const now = new Date();
          const events = await session.getEvents();
          const cwd = lastCwd(events) || process.cwd();
          const file = cliOutputPath(a.path, cwd, ctx.sessionId, { resolve, join, isAbsolute });
          write(file, renderCliExport({ events, sessionId: ctx.sessionId, now, cwd }));
          await announce(`Session exported to: ${file}`, file);
        } catch (err) {
          await tell(`/export に失敗しました: ${err?.message ?? err}`, "error");
        }
      },
    },
    {
      name: "save-session",
      description: "使用量付きのセッションの記録を Markdown に書き出す(モデルは呼ばない)。引数: 出力先のフォルダか .md のパス",
      handler: async (ctx) => {
        try {
          const now = new Date();
          const events = await session.getEvents();
          let metrics = null;
          try {
            metrics = await session.rpc.usage.getMetrics();
          } catch {
            // 使用量の API は実験的。取れなくても経過は書き出す
          }
          const file = outputPath(ctx.args, lastCwd(events) || process.cwd(), ctx.sessionId, now);
          write(file, renderSession({ events, metrics, sessionId: ctx.sessionId, now }));
          await announce(`セッションの記録を書き出しました: ${file}`, file);
        } catch (err) {
          await tell(`/save-session に失敗しました: ${err?.message ?? err}`, "error");
        }
      },
    },
  ],
});
