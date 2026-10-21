// docs/customize/advanced(詳細資料・上級者向け)のスライド版(customize-guide-advanced.pptx)を生成する。入門版は _build.js。
// 実行: NODE_PATH=<pptxgenjs を入れた node_modules> node docs/customize/slides/_build-advanced.js
// 画像は ../images/*.png(_make.py --png で生成)を使う。本文(Markdown)が正で、ここは要点の写し。
const path = require("path");
const fs = require("fs");
const pptxgen = require("pptxgenjs");

const HERE = __dirname;
const IMG = path.join(HERE, "..", "images");
const OUT = path.join(HERE, "customize-guide-advanced.pptx");
const APPLY = process.env.APPLY_THEME_JS; // skill の apply_theme.js へのパス(任意)

const THEME = {
  name: "Harness",
  headFontFace: "Meiryo",
  bodyFontFace: "Meiryo",
  colors: {
    dk1: "1F2933", lt1: "FFFFFF", dk2: "52606D", lt2: "F0F4F8",
    accent1: "0F766E", accent2: "F9A825", accent3: "1E88E5",
    accent4: "43A047", accent5: "FB8C00", accent6: "8E24AA",
    hlink: "0F766E", folHlink: "52606D",
  },
};
// 章の色(図版と揃える): 1 指示=青, 2 スキル=緑, 3 エージェント=橙, 4 MCP=紫, 5 ハーネス=琥珀
const pres = new pptxgen();
pres.layout = "LAYOUT_16x9"; // 10 x 5.625 in
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
pres.title = "カスタマイズとユーザーハーネス";
pres.author = "配布資料";
const C = pres.SchemeColor;
const CH = { 1: C.accent3, 2: C.accent4, 3: C.accent5, 4: C.accent6, 5: C.accent2 };
const CH_HEX = { 1: "1E88E5", 2: "43A047", 3: "FB8C00", 4: "8E24AA", 5: "F9A825" };
const TINT = { 1: "E3F2FD", 2: "E8F5E9", 3: "FFF3E0", 4: "F3E5F5", 5: "FFFDE7" };

const FOOTER = "カスタマイズとユーザーハーネス(2026-10)";

pres.defineSlideMaster({
  title: "TITLE",
  background: { color: THEME.colors.dk1 },
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.6, y: 1.6, w: 8.8, h: 1.4, fontSize: 30, bold: true, color: C.background1, valign: "bottom", margin: 0 } } },
    { placeholder: { options: { name: "body", type: "body", x: 0.6, y: 3.1, w: 8.8, h: 1.2, fontSize: 15, color: C.background2, valign: "top", margin: 0 } } },
  ],
});
pres.defineSlideMaster({
  title: "SECTION",
  background: { color: THEME.colors.dk1 },
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.6, y: 2.2, w: 8.8, h: 1.0, fontSize: 30, bold: true, color: C.background1, valign: "middle", margin: 0 } } },
    { placeholder: { options: { name: "body", type: "body", x: 0.6, y: 3.25, w: 8.8, h: 1.2, fontSize: 14, color: C.background2, valign: "top", margin: 0 } } },
    { text: { text: FOOTER, options: { x: 0.5, y: 5.2, w: 7, h: 0.3, fontSize: 9, color: C.text2, margin: 0 } } },
  ],
});
pres.defineSlideMaster({
  title: "CONTENT",
  background: { color: THEME.colors.lt1 },
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.5, y: 0.3, w: 9, h: 0.6, fontSize: 22, bold: true, color: C.text1, valign: "middle", margin: 0 } } },
    { text: { text: FOOTER, options: { x: 0.5, y: 5.25, w: 7, h: 0.25, fontSize: 8, color: C.text2, margin: 0 } } },
  ],
  slideNumber: { x: 9.1, y: 5.25, w: 0.5, h: 0.25, fontSize: 8, color: C.text2, align: "right" },
});

// ---------------------------------------------------------------- helpers
let n = 0;
function content(title, section) {
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: section });
  s.addText(title, { placeholder: "title" });
  n++;
  return s;
}
function txt(s, x, y, w, h, text, o = {}) {
  s.addText(text, Object.assign({ x, y, w, h, fontSize: 12, color: C.text1, isTextBox: true, margin: 0, valign: "top", objectName: "text" }, o));
}
function card(s, x, y, w, h, head, body, ch, o = {}) {
  s.addShape(pres.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.08, fill: { color: o.fill || TINT[ch] }, line: { color: CH_HEX[ch], width: 1 }, objectName: "card" });
  if (head) s.addText(head, { x: x + 0.15, y: y + 0.1, w: w - 0.3, h: 0.32, fontSize: o.headSize || 13, bold: true, color: CH[ch], isTextBox: true, margin: 0, valign: "top", objectName: "card-head" });
  if (body) s.addText(body, { x: x + 0.15, y: y + (head ? 0.45 : 0.12), w: w - 0.3, h: h - (head ? 0.55 : 0.24), fontSize: o.bodySize || 11, color: C.text1, isTextBox: true, margin: 0, valign: "top", paraSpaceAfter: 3, objectName: "card-body" });
}
function plain(s, x, y, w, h, head, body, o = {}) {
  s.addShape(pres.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.08, fill: { color: THEME.colors.lt2 }, line: { color: "D9E2EC", width: 1 }, objectName: "card" });
  if (head) s.addText(head, { x: x + 0.15, y: y + 0.1, w: w - 0.3, h: 0.32, fontSize: o.headSize || 13, bold: true, color: C.text1, isTextBox: true, margin: 0, valign: "top", objectName: "card-head" });
  if (body) s.addText(body, { x: x + 0.15, y: y + (head ? 0.45 : 0.12), w: w - 0.3, h: h - (head ? 0.55 : 0.24), fontSize: o.bodySize || 11, color: C.text1, isTextBox: true, margin: 0, valign: "top", paraSpaceAfter: 3, objectName: "card-body" });
}
function chip(s, x, y, label, ch, d = 0.42) {
  s.addShape(pres.ShapeType.ellipse, { x, y, w: d, h: d, fill: { color: CH_HEX[ch] }, line: { color: CH_HEX[ch] }, objectName: "chip" });
  s.addText(label, { x, y, w: d, h: d, fontSize: 13, bold: true, color: C.background1, align: "center", valign: "middle", isTextBox: true, margin: 0, objectName: "chip-label" });
}
function bullets(lines, size = 12) {
  return lines.map((t, i) => ({ text: t, options: { bullet: true, breakLine: i < lines.length - 1, fontSize: size, paraSpaceAfter: 4 } }));
}
function table(s, x, y, w, rows, colW, o = {}) {
  const fs = o.fontSize || 10.5;
  const data = rows.map((r, i) => r.map((c) => ({
    text: c,
    options: i === 0
      ? { bold: true, color: THEME.colors.lt1, fill: { color: o.headFill || THEME.colors.accent1 }, fontSize: fs, valign: "middle" }
      : { color: THEME.colors.dk1, fill: { color: i % 2 ? THEME.colors.lt1 : THEME.colors.lt2 }, fontSize: fs, valign: "top" },
  })));
  s.addTable(data, { x, y, w, colW, border: { type: "solid", color: "D9E2EC", pt: 0.75 }, margin: 0.05, autoPage: false, objectName: "table", rowH: o.rowH });
}
function image(s, file, x, y, w) {
  const dims = { "fig1-parts-timeline.png": [960, 570], "fig2-skill-activation.png": [960, 500], "fig3-harness-parts.png": [960, 560], "fig4-phase-loop.png": [960, 420], "fig5-mcp.png": [960, 420] };
  const [pw, ph] = dims[file];
  const alt = { "fig1-parts-timeline.png": "4 つの部品がセッションのどの時点で文脈に乗るかを示す図", "fig2-skill-activation.png": "スキルの description と本文が読まれる順序の図", "fig3-harness-parts.png": "ユーザーハーネスの部品と、誰が何を読むかの図", "fig4-phase-loop.png": "フェーズゲートの 1 周と周回上限の図", "fig5-mcp.png": "MCP クライアントとサーバーの関係の図" }[file];
  s.addImage({ path: path.join(IMG, file), x, y, w, h: (w * ph) / pw, objectName: alt, altText: alt });
}
function section(num, title, sub) {
  pres.addSection({ title: `${num}. ${title}` });
  const s = pres.addSlide({ masterName: "SECTION", sectionTitle: `${num}. ${title}` });
  s.addShape(pres.ShapeType.ellipse, { x: 0.6, y: 1.1, w: 0.9, h: 0.9, fill: { color: CH_HEX[num] }, line: { color: CH_HEX[num] }, objectName: "chip" });
  s.addText(String(num), { x: 0.6, y: 1.1, w: 0.9, h: 0.9, fontSize: 28, bold: true, color: C.background1, align: "center", valign: "middle", isTextBox: true, margin: 0, objectName: "chip-label" });
  s.addText(title, { placeholder: "title" });
  s.addText(sub, { placeholder: "body" });
  n++;
}
function code(s, x, y, w, h, text, size = 9.5) {
  s.addShape(pres.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.06, fill: { color: "F7F9FB" }, line: { color: "D9E2EC", width: 1 }, objectName: "code-bg" });
  s.addText(text, { x: x + 0.12, y: y + 0.08, w: w - 0.24, h: h - 0.16, fontSize: size, fontFace: "Consolas", color: C.text1, isTextBox: true, margin: 0, valign: "top", objectName: "code" });
}

// ================================================================ 0. 導入
pres.addSection({ title: "導入" });
{
  const s = pres.addSlide({ masterName: "TITLE", sectionTitle: "導入" });
  s.addText("カスタマイズとユーザーハーネス", { placeholder: "title" });
  s.addText("指示・スキル・カスタムエージェント・MCP の 4 つの部品と、\nそれらを組み合わせて「実装 → 審査 → ゲート」を回すユーザーハーネス", { placeholder: "body" });
  [1, 2, 3, 4, 5].forEach((i, k) => s.addShape(pres.ShapeType.ellipse, { x: 0.6 + k * 0.5, y: 4.6, w: 0.32, h: 0.32, fill: { color: CH_HEX[i] }, line: { color: CH_HEX[i] }, objectName: "dot" }));
  s.addText("GitHub Copilot(CLI・アプリ)で説明。デファクトスタンダードの形式。2026-10 時点", { x: 3.3, y: 4.6, w: 6.2, h: 0.32, fontSize: 10.5, color: C.background2, isTextBox: true, margin: 0, valign: "middle", objectName: "note" });
  s.addNotes("本文(Markdown)が正。スライドは説明会用の要点。");
  n++;
}
{
  const s = content("導入編で済んだこと、本資料で到達すること", "導入");
  plain(s, 0.5, 1.1, 4.3, 3.8, "導入編", "");
  s.addText(bullets(["Copilot appの導入とサインイン", "文脈(コンテキスト)・トークン・worktree の概念", "モデルの考え方", "コードの修正とバグ修正の実演"], 12), { x: 0.7, y: 1.6, w: 3.9, h: 3.1, isTextBox: true, margin: 0, valign: "top", color: C.text1, objectName: "list" });
  card(s, 5.2, 1.1, 4.3, 3.8, "本資料の到達目標", "", 5);
  s.addText(bullets(["4 つの部品の仕組みと Copilot での置き場が分かる", "description が発動を決めることを体で知る", "審査役を読み取り専用にする理由と方法が言える", "自分のリポジトリでユーザーハーネスを 1 周回せる"], 12), { x: 5.4, y: 1.6, w: 3.9, h: 3.1, isTextBox: true, margin: 0, valign: "top", color: C.text1, objectName: "list" });
}
{
  const s = content("この資料の方針と、載せる機能の基準", "導入");
  card(s, 0.5, 1.1, 2.9, 2.0, "デファクトで説明", "置き場・書式・呼び方は GitHub Copilot(CLI とアプリ)のもの。他環境の登録方法は説明しない(付録に対応の有無だけ)", 1);
  card(s, 3.55, 1.1, 2.9, 2.0, "基準は 1 つ", "Copilot で対応し、かつ他のエージェント環境のどれか 1 つ以上で同じ形式か考え方が通用するもの。1 環境だけ非対応でも問題にしない", 5);
  card(s, 6.6, 1.1, 2.9, 2.0, "廃れるものを書かない", "モデル名・価格・画面の細部・言い回しの技は書かない。版で変わるものには時点(2026-10)を付ける", 3);
  table(s, 0.5, 3.35, 9, [
    ["機能", "Copilot CLI", "他環境の例", "判定"],
    ["指示 / スキル / カスタムエージェント / MCP", "✓", "Claude Code、OpenCode、Codex", "本文で扱う(第 1〜4 章)"],
    ["フック / プラグイン", "✓", "Claude Code、Codex", "基準は満たすが部品ではない → 付録で概要だけ"],
    ["プロンプトファイル(.prompt.md)", "✗", "—", "載せない。スキルの /名前 起動で代替"],
  ], [3.2, 1.0, 2.2, 2.6]);
}
{
  const s = content("用語: この資料での意味", "導入");
  card(s, 0.5, 1.1, 4.3, 1.75, "エージェント環境", "コードを読み書きしコマンドを実行する実行環境。既定は Copilot app(Copilot CLI の上に構築 ◎)。Claude Code、OpenCode、Codex も同じ層", 1);
  card(s, 5.2, 1.1, 4.3, 1.75, "ユーザーハーネス", "利用者が自分で組む運用の仕組み。実装役・審査役のエージェント + HARNESS.md(フェーズとゲート条件)+ 起動スキル + 結果の置き場。実行環境を指す「ハーネス」とは別の意味", 5);
  card(s, 0.5, 3.05, 4.3, 1.75, "文脈(コンテキスト)", "モデルが 1 回の応答で読める入力の全体。指示・スキルの description・MCP のツール定義は常時ここに乗る", 3);
  card(s, 5.2, 3.05, 4.3, 1.75, "ゲート条件 / 確度の記号", "審査役が機械的に確認できる合格条件。「正しく動く」は条件ではない。\n◎ 公式文書で確認 / △ 実測・単一事例 / ▲ 推測", 2);
}
{
  const s = content("全体図: 4 つの部品と、いつ文脈に乗るか", "導入");
  image(s, "fig1-parts-timeline.png", 1.5, 0.95, 7.0);
}

// ================================================================ 1. 指示
section(1, "指示ファイル", "常時読まれる前提の置き方。層と優先、前提と手順の切り分け、正典を 1 か所にする");
{
  const s = content("1. 指示: 仕組みと Copilot が読む場所(2026-10 ◎)", "1. 指示ファイル");
  s.addText(bullets(["セッション開始時に決まった場所の指示を全部読んで結合する。優先順位は無く、重複は除かれる", "編集しても動いているセッションには反映されない → /new で始め直す", "/instructions で一覧と個別の無効化、--no-custom-instructions で全部無効"], 11.5), { x: 0.5, y: 1.05, w: 9, h: 1.1, isTextBox: true, margin: 0, valign: "top", color: C.text1, objectName: "list" });
  table(s, 0.5, 2.25, 9, [
    ["層", "場所", "効く範囲"],
    ["ユーザー", "~/.copilot/copilot-instructions.md、~/.copilot/instructions/**/*.instructions.md", "自分の全リポジトリ"],
    ["リポジトリ全体", "AGENTS.md、.github/copilot-instructions.md", "そのリポジトリの全依頼"],
    ["ディレクトリ", "作業中のファイルの経路にある AGENTS.md(ネスト)", "そのディレクトリ以下"],
    ["パス別", ".github/instructions/**/*.instructions.md(applyTo に glob)", "glob に合うファイルを扱うとき"],
    ["他環境由来", "CLAUDE.md、.claude/CLAUDE.md、GEMINI.md", "読む(共存できる)"],
  ], [1.6, 5.0, 2.4]);
  txt(s, 0.5, 4.75, 9, 0.4, "迷ったら AGENTS.md(Copilot・OpenCode・Codex が読む。Claude Code は CLAUDE.md が無ければ読む)。Copilot 専用の内容が出たときだけ copilot-instructions.md を足す。委譲で呼んだカスタムエージェントには include-custom-instructions: true が要る", { fontSize: 10.5, color: C.text2 });
}
{
  const s = content("1. 指示: 書き方の原則と最小の例", "1. 指示ファイル");
  const rules = [["前提を書く。手順を書かない", "「常にこうである」は指示。「〜のときはこうする」はスキルへ"], ["短く", "毎回の依頼に全文が乗る。100 行を超えたら applyTo 付きに分割 ▲"], ["正典は 1 か所", "複製すると直したとき届かない箇所が残る(8 日間届かなかった事例 △)"], ["推測を事実のように書かせない", "測った値と見た出力だけ。文書が無ければ止めて報告"], ["パスで切れる規約は applyTo へ", "そのディレクトリを扱うときだけ読まれればよい"]];
  rules.forEach((r, i) => {
    chip(s, 0.5, 1.1 + i * 0.78, String(i + 1), 1, 0.36);
    txt(s, 1.0, 1.08 + i * 0.78, 3.6, 0.3, r[0], { fontSize: 12, bold: true });
    txt(s, 1.0, 1.4 + i * 0.78, 3.6, 0.45, r[1], { fontSize: 10.5, color: C.text2 });
  });
  code(s, 4.9, 1.1, 4.6, 3.9, "# このリポジトリで作業するときの前提\n\n- ビルド: cmake --build build\n  テスト: ctest --test-dir build --output-on-failure\n  どちらも成功するまで「完了」と報告しない\n- 報告は日本語。測った値・見た出力だけを書く\n- コミットしない。差分は作業ツリーに残す\n- tests/ のテストコードを変えない。\n  変えないと通らないときは止めて報告する\n- 外部ライブラリの API は、インストール済みの版の\n  ヘッダか文書の該当箇所(path:line)を報告に添える\n- 分からないことは推測で進めず、選択肢を並べて聞く", 9.5);
}

// ================================================================ 2. スキル
section(2, "スキル", "手順と知識を「必要なときだけ」読ませる。Agent Skills 標準。description が発動を決める");
{
  const s = content("2. スキル: description が発動を決める", "2. スキル");
  image(s, "fig2-skill-activation.png", 1.2, 1.0, 7.6);
}
{
  const s = content("2. スキル: 形式(Agent Skills 仕様 ◎)と Copilot での登録", "2. スキル");
  code(s, 0.5, 1.05, 4.6, 2.55, "---\nname: build-and-test\ndescription: Use when asked to build the project,\n  run the tests, or check why a build or test fails\n  (e.g. \"ビルドして\", \"テストを回して\").\n  Not for writing new tests.\n---\n# ビルドとテスト\n## 手順\n1. cmake --build build。失敗したら末尾 20 行を貼って止まる\n2. ctest --test-dir build --output-on-failure。件数を報告\n## 品質基準\n- 実行した結果だけを書く。テストコードは変えない", 8.5);
  txt(s, 0.5, 3.7, 4.6, 1.4, "name: 1〜64 字、小文字英数字とハイフン、ディレクトリ名と一致\ndescription: 1〜1024 字。何をするかと、いつ使うか\n本文 500 行以内を推奨。長い資料は references/ へ\n任意: license、compatibility、metadata、allowed-tools(事前承認。shell は使わない)", { fontSize: 10.5, color: C.text2 });
  table(s, 5.3, 1.05, 4.2, [
    ["操作", "Copilot での方法"],
    ["置き場", ".github/skills/<name>/SKILL.md(.agents/skills、.claude/skills も読む)。個人用は ~/.copilot/skills/"],
    ["一覧 / 詳細", "/skills list、/skills info <name>"],
    ["追加", "置いて /skills reload。または /skills add [--project] <file|url|dir>"],
    ["手動起動", "/<name> 引数(合致判断を飛ばす)"],
    ["アプリ", "Customize → Skills。リポジトリ・CLI のスキルは自動で使える ◎"],
  ], [1.1, 3.1], { fontSize: 9.5 });
  txt(s, 5.3, 4.5, 4.2, 0.6, "同名は先に見つかった方が勝つ(リポジトリ > 個人)◎。置き場は .github/skills/ に統一する", { fontSize: 10.5, color: C.text2 });
}
{
  const s = content("2. スキル: description の書き方", "2. スキル");
  card(s, 0.5, 1.1, 4.3, 1.6, "悪い(内容の要約)", "「設定ファイル形式の仕様と変換手順」\n→ 依頼文と照合できない。本文がどれほど良くても読まれない", 3, { fill: "FFF5F5" });
  card(s, 5.2, 1.1, 4.3, 1.6, "良い(場面)", "Use when asked to convert a config file from the old format to the current one, or when a config fails to load after migration. Not for explaining the format.", 2);
  const rules = ["「Use when ...」で始め「Not for ...」で終える。陽性と陰性の両方を書く", "利用者が実際に打つ言い回しを入れる(日本語の言い回しも括弧で)", "スキル名を繰り返さない。形容詞を書かない(「包括的な」は照合に効かない)", "2〜3 文で足りる。長い description は毎回のコスト", "発動しないときに直すのは description。本文を直しても発動は変わらない"];
  rules.forEach((r, i) => { chip(s, 0.5, 2.95 + i * 0.42, String(i + 1), 2, 0.32); txt(s, 0.95, 2.97 + i * 0.42, 8.5, 0.35, r, { fontSize: 11.5 }); });
}
{
  const s = content("2. スキル: 作り方の 5 段と、増やしすぎない", "2. スキル");
  const steps = [["依頼票", "人が書く唯一の入力。発動させたい場面・させたくない場面・知らない事実と出典・受け入れ基準"], ["形式検査", "name とディレクトリ名、description 1024 字、本文 500 行、相対パス、絶対パス無し。機械的に"], ["発動試験", "陽性・陰性ケースをそのまま打つ。結果を TEST_LOG.md に残す"], ["レビュー", "票を書いた人とは別の人。票に無いことが無い、事実に出典、手順は意図と品質基準で"], ["配置", ".github/skills/ に置き、/skills list に出ることを目視。見えた日付を記録"]];
  steps.forEach((st, i) => {
    const x = 0.5 + i * 1.84;
    card(s, x, 1.1, 1.7, 2.5, `段 ${i + 1} ${st[0]}`, st[1], 2, { headSize: 12, bodySize: 9.5 });
    if (i < 4) s.addShape(pres.ShapeType.rightArrow, { x: x + 1.7, y: 2.15, w: 0.14, h: 0.3, fill: { color: THEME.colors.dk2 }, line: { color: THEME.colors.dk2 }, objectName: "arrow" });
  });
  plain(s, 0.5, 3.85, 9, 1.25, "増やしすぎない", "全スキルの description が毎回の判断に乗るので、1 本増やすたびに他の全スキルの発動精度が下がる。同時に置くのは 10 本以内を目安に ▲。\nスキルにする前に自問: 常にこうである前提(→ 指示)ではないか、1 回しか使わない手順(→ 依頼文)ではないか、特定の役割だけの規則(→ エージェント本文)ではないか");
}

// ================================================================ 3. エージェント
section(3, "カスタムエージェント", "役割を固定し、分業させる。選択と委譲、読み取り専用の審査役、委譲のコスト。持ち運べるのは設計で、書式ではない");
{
  const s = content("3. エージェント: 仕組み、置き場、優先(2026-10 ◎)", "3. カスタムエージェント");
  s.addText(bullets([".agent.md(Markdown + YAML frontmatter)。本文 30,000 字以内", "選ぶ: /agent で一覧から、依頼文で名前を挙げる、--agent=<name>", "委譲される: 本体が description に合うと判断するとサブエージェントとして起動。独自の文脈ウィンドウ、並列可", "委譲で呼ばれたときは既定でリポジトリの指示を受け取らない → include-custom-instructions: true"], 11.5), { x: 0.5, y: 1.05, w: 9, h: 1.5, isTextBox: true, margin: 0, valign: "top", color: C.text1, objectName: "list" });
  table(s, 0.5, 2.65, 9, [
    ["優先", "場所", "備考"],
    ["1(最優先)", "~/.copilot/agents/<name>.agent.md", "個人用。リポジトリより優先される ◎"],
    ["2", ".github/agents/<name>.agent.md", "作業ディレクトリから git ルートまで探す"],
    ["3〜", ".claude/agents/、--add-dir、プラグイン、組織・エンタープライズ", "同じ ID は先に読まれた方 ◎"],
  ], [1.2, 4.0, 3.8]);
  txt(s, 0.5, 4.45, 9, 0.7, "アプリでは /agent で選ぶ ◎。アプリが .github/agents/ を直接読むかは公式に明記が無い ▲ → 手元の環境で確かめる。\nチームの定義と同名のものを ~/.copilot/agents/ に置かない(個人が勝つ)", { fontSize: 10.5, color: C.text2 });
}
{
  const s = content("3. エージェント: frontmatter", "3. カスタムエージェント");
  code(s, 0.5, 1.05, 3.9, 1.7, "---\nname: reviewer\ndescription: 実装済みフェーズを HARNESS.md の\n  ゲート条件で検証し、証拠付きで PASS/FAIL を\n  判定する読み取り専用の審査役。コードは直さない。\ntools: [\"read\", \"search\", \"execute\"]\ninclude-custom-instructions: true\n---", 8.5);
  txt(s, 0.5, 2.9, 3.9, 2.2, "本文には「守ること」と「報告の形式」だけ。作業手順は HARNESS.md とスキルに任せる(手順まで書くと食い違う)。\n\ndescription は人が選ぶときには効かないが、本体が自動で委譲するかの判断に使われる ◎。やること・やらないことを書く", { fontSize: 10.5, color: C.text2 });
  table(s, 4.6, 1.05, 4.9, [
    ["キー", "意味 / 注意"],
    ["description(必須)", "一覧に出る。委譲の判断材料"],
    ["tools", "省くと全部。* で全部、[] で禁止。エイリアス execute / read / edit / search / agent / web / todo。MCP は server/tool。知らない名前は黙って無視 ◎"],
    ["model など", "省くと本体と同じ。固定が要ると分かってから書く"],
    ["disable-model-invocation", "true で自動委譲を禁止(共通リファレンス ◎)。CLI 文書は infer のみ。手元の環境で確認 △"],
    ["user-invocable", "false で人が選べない(委譲専用)"],
    ["include-custom-instructions", "委譲時にリポジトリの指示を読む。実装役・審査役は true"],
  ], [1.7, 3.2], { fontSize: 9.5 });
}
{
  const s = content("3. エージェント: 審査役を読み取り専用にする(三重化)", "3. カスタムエージェント");
  const layers = [["1. ツール制限", "tools から edit を外す", "抜け道: execute があればシェルで書ける。execute を外すと測り直しができないので両立しない"], ["2. 指示本文", "「ファイルを書かない。直したくなったら FAIL」", "指示は確率的に守られる。実測では「シェルで書いてよい」と頼んでも編集せず FAIL を返した △(1 回)"], ["3. 外側の git diff 比較", "オーケストレータが審査の前後で git diff と git status を採取して比較。差分があれば判定を無効に", "検出であって防止ではない。モデルや版が変わっても効く唯一の層。省かない"]];
  layers.forEach((l, i) => {
    card(s, 0.5 + i * 3.05, 1.1, 2.9, 2.6, l[0], l[1] + "\n\n" + l[2], 3, { headSize: 13, bodySize: 10.5 });
  });
  plain(s, 0.5, 3.9, 9, 1.2, "実装役と審査役を同じモデル・似た指示にしない", "同じモデルは同じ見落としをする。審査役の本文は「疑う」「測り直す」「信じない」を軸に別に書く。陽性コントロールは方法を書く(「隔離コピーで実装を壊してテストが落ちることを示す」)。方法を書かないと安いモデルは弱い確認で済ませる △(4 回中 3 回)");
}
{
  const s = content("3. エージェント: 委譲のコスト(実測 △ 2026-10-19、各 1 回)", "3. カスタムエージェント");
  card(s, 0.5, 1.1, 4.3, 2.3, "", "", 3, { fill: THEME.colors.lt2 });
  s.addText("0.96", { x: 0.7, y: 1.2, w: 3.9, h: 1.0, fontSize: 54, bold: true, color: C.accent1, isTextBox: true, margin: 0, valign: "middle", objectName: "stat" });
  txt(s, 0.7, 2.25, 3.9, 1.0, "AI credits — 手動 2 セッション\n実装役・審査役を別々に起動。役ごとの消費がそのまま", { fontSize: 11.5 });
  card(s, 5.2, 1.1, 4.3, 2.3, "", "", 3, { fill: THEME.colors.lt2 });
  s.addText("2.01", { x: 5.4, y: 1.2, w: 3.9, h: 1.0, fontSize: 54, bold: true, color: C.accent5, isTextBox: true, margin: 0, valign: "middle", objectName: "stat" });
  txt(s, 5.4, 2.25, 3.9, 1.0, "AI credits — 本体 1 セッションから委譲\n本体が文脈を持ち続ける代金(本体だけで 0.82)。サブエージェント単体は手動より安い", { fontSize: 11.5 });
  s.addText(bullets(["委譲は便利だが、本体の文脈を溜めないことが安さの条件。本体は「渡すだけ」にする", "基準値取りや小さなフェーズは手動 2 セッション。量産は委譲でもよい", "委譲が本当に起きたかは使用量表示で確かめる(本体とサブエージェントの消費が分かれて出る △)。「委譲したつもり」が静かに起きていないことがある"], 11.5), { x: 0.5, y: 3.6, w: 9, h: 1.5, isTextBox: true, margin: 0, valign: "top", color: C.text1, objectName: "list" });
}

// ================================================================ 4. MCP
section(4, "MCP", "外部のツールとデータに同じ作法でつなぐ。設定と権限、「CLI があるなら MCP にしない」判断");
{
  const s = content("4. MCP: 位置づけ", "4. MCP");
  image(s, "fig5-mcp.png", 0.9, 1.0, 8.2);
}
{
  const s = content("4. MCP: Copilot での設定と登録(2026-10 ◎)", "4. MCP");
  code(s, 0.5, 1.05, 4.4, 2.6, "{\n  \"mcpServers\": {\n    \"playwright\": {\n      \"type\": \"local\",\n      \"command\": \"npx\",\n      \"args\": [\"@playwright/mcp@latest\"],\n      \"tools\": [\"*\"]\n    },\n    \"docs-search\": {\n      \"type\": \"http\",\n      \"url\": \"https://example.internal/mcp\",\n      \"tools\": [\"search\", \"fetch\"]\n    }\n  }\n}", 8.5);
  txt(s, 0.5, 3.75, 4.4, 1.35, "type は local(stdio)か http。tools は使うツールの許可リスト(既定 *)。\n秘密情報を設定ファイルに直書きしない。.github/mcp.json はコミットされる。秘密を要するサーバーは個人用に置く", { fontSize: 10.5, color: C.text2 });
  table(s, 5.1, 1.05, 4.4, [
    ["層", "場所 / 備考"],
    ["個人", "~/.copilot/mcp-config.json。/mcp add、copilot mcp add はここ"],
    ["リポジトリ(共有)", ".github/mcp.json。コミットして共有"],
    ["リポジトリ(ローカル)", ".mcp.json。近いファイルが優先。フォルダ信頼後にだけ読む ◎"],
    ["読まれない", ".vscode/mcp.json(servers キー)"],
    ["組み込み", "GitHub MCP サーバーは設定なしで使える ◎"],
    ["操作", "/mcp list | show | add | edit | delete | disable | enable、/env"],
    ["アプリ", "Customize → MCP。リポジトリ・CLI の設定は自動で使える ◎"],
  ], [1.4, 3.0], { fontSize: 9.5 });
}
{
  const s = content("4. MCP: 権限と設計の判断", "4. MCP");
  card(s, 0.5, 1.1, 4.3, 3.9, "権限(確認ダイアログ)", "", 4);
  s.addText(bullets(["MCP のツール呼び出しは承認の対象 ◎。今回だけ / セッション中 / このリポジトリでは今後聞かない", "--allow-tool / --deny-tool。MCP は Server(tool) の形。deny が allow より優先 ◎", "保存された承認は ~/.copilot/permissions-config.json。拒否は保存されない", "--allow-all-tools / /yolo は使わない(人が最後の砦になれなくなる)", "Business / Enterprise は組織ポリシー(MCP servers in Copilot は既定で無効 ◎、許可リストは CLI・アプリでも強制 ◎)。導入前に管理者に現状を確認"], 10.5), { x: 0.7, y: 1.6, w: 3.9, h: 3.3, isTextBox: true, margin: 0, valign: "top", color: C.text1, objectName: "list" });
  card(s, 5.2, 1.1, 4.3, 3.9, "設計の判断", "", 5);
  s.addText(bullets(["既に CLI があるものは MCP にしない。gh、git、ビルドツールはスキルから直接叩く方が透過的で、ツール定義のコストも無い", "ツール定義は常時のコスト。tools の許可リストで絞る。使わないサーバーは /mcp disable", "ツールの出力は信頼できない入力。Issue 本文や Web ページに混ざった指示に従わせない(指示ファイルに書く)", "書き込み系ツールの確認を飛ばさない", "リポジトリに置く設定に秘密を書かない"], 10.5), { x: 5.4, y: 1.6, w: 3.9, h: 3.3, isTextBox: true, margin: 0, valign: "top", color: C.text1, objectName: "list" });
}

// ================================================================ 5. ユーザーハーネス
section(5, "ユーザーハーネス", "部品を組み合わせて 1 周回す。HARNESS.md をエージェントと相談して書く、陽性コントロール、共有の仕方");
{
  const s = content("5. ハーネス: 何を解決するか", "5. ユーザーハーネス");
  const rows = [["「動きました」が証拠にならない", "作った本人とは別の審査役が、自分で測り直して判定する", "審査役"], ["頼んでいない所まで直す", "HARNESS.md に「実装:」1 行とゲート条件。それ以外は未解決事項に書かせる", "HARNESS.md"], ["直して壊して、が止まらない", "起動スキルで 1 周の手順と周回上限(3)を固定し、超えたら人に戻す", "phase-loop"], ["どこまで検証したか分からない", "TEST_REPORT.md と phase-log.csv に結果と周回数を 1 行ずつ残す", "記録"]];
  rows.forEach((r, i) => {
    const y = 1.1 + i * 0.98;
    plain(s, 0.5, y, 3.6, 0.85, "", r[0], { bodySize: 12 });
    s.addShape(pres.ShapeType.rightArrow, { x: 4.2, y: y + 0.28, w: 0.4, h: 0.3, fill: { color: THEME.colors.dk2 }, line: { color: THEME.colors.dk2 }, objectName: "arrow" });
    card(s, 4.7, y, 4.8, 0.85, r[2], r[1], 5, { headSize: 11, bodySize: 10.5 });
  });
}
{
  const s = content("5. ハーネス: 部品と、誰が何を読むか", "5. ユーザーハーネス");
  image(s, "fig3-harness-parts.png", 0.7, 0.95, 7.2);
  txt(s, 8.4, 1.0, 1.2, 4.0, "人が一から書くのは HARNESS.md だけ。\n\n残りは雛形の {{ }} を埋める。\n\n雛形: templates/", { fontSize: 10.5, color: C.text2 });
}
{
  const s = content("5. ハーネス: 1 周の流れ", "5. ユーザーハーネス");
  image(s, "fig4-phase-loop.png", 0.9, 1.0, 8.2);
  txt(s, 0.9, 4.7, 8.2, 0.45, "人: 「/phase-loop 2」→ 復唱 → implementer に委譲 → 審査前 git diff と status → reviewer に委譲 → 審査後に比較 → FAIL なら差し戻し(最大 3 周)/ PASS なら人がコミットして記録", { fontSize: 10.5, color: C.text2 });
}
{
  const s = content("5. ハーネス: 運用則(変えない)と、その理由", "5. ユーザーハーネス");
  table(s, 0.5, 1.05, 9, [
    ["則", "理由(実証で何が起きたか)"],
    ["審査役はコードを直さない", "直せる審査役は実装役に遠慮する。判定と証拠だけにすると敵対的に検証し、自己検証をすり抜けたバグを捕捉した △"],
    ["審査役は自分で測り直す", "「成功しました」は証拠ではない。嘘の報告 + 仕込んだバグを渡した実測で、全条件を再実行して FAIL を返した △"],
    ["再レビューは再現手順の再実行で閉じる", "修正差分を読んだだけの PASS は、同じ穴が別経路で残っているのを見逃す"],
    ["陽性コントロールを入れる(方法を書く)", "「検出できない検査」が PASS を量産する。方法を書かないと弱い確認で済まされる △"],
    ["未検証は理由付きで残す", "環境起因は時間を区切って見切り、➖ として記録。「なんとなく合格」を作らない"],
    ["最大 3 周", "収束しないフェーズはスコープか要件の問題。モデルを上げても解決しない。人が分割する"],
    ["完了報告は定型", "「未解決事項」欄が次のレビュー観点の供給源。自由形式だと欄が消える"],
    ["審査前後の git diff と git status を比較する", "三重化の 3 層目。モデルや版が変わっても効く唯一の層。未追跡ファイルは diff に出ない"],
  ], [3.0, 6.0], { fontSize: 9.5 });
}
{
  const s = content("5. ハーネス: 作る手順", "5. ユーザーハーネス");
  const steps = [["0 前提", "ビルド・テストが各 1 行で動く。git status がきれい。e2e-artifacts/ を gitignore。AGENTS.md がある"], ["1 HARNESS.md", "エージェントと相談して書く(次のスライド)。環境の節だけは人が埋める"], ["2 エージェント", "雛形を .github/agents/ にコピー。/agent に出る。審査役が編集を断る。実装役がコマンドを実行できる"], ["3 起動スキル", "phase-loop を .github/skills/ に。/skills list に出る"], ["4 結果の置き場", "docs/TEST_REPORT.md(環境 ID と外部 API の版を埋める)。phase-log.csv は初回に生成"], ["5 導入チェック", "陰性: /phase-loop 0 が PASS。陽性: 壊した実装で FAIL。両方を Phase 0 に記録"], ["6 運用", "1 フェーズ 1 セッション(= 1 ブランチ ◎)。モデルは既定のまま。週 1 回、兆候チェック"]];
  steps.forEach((st, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = 0.5 + col * 4.6, y = 1.05 + row * 1.02;
    chip(s, x, y + 0.08, st[0].split(" ")[0], 5, 0.36);
    txt(s, x + 0.5, y + 0.05, 3.9, 0.3, st[0].slice(2), { fontSize: 12, bold: true });
    txt(s, x + 0.5, y + 0.36, 3.9, 0.62, st[1], { fontSize: 10, color: C.text2 });
  });
}
{
  const s = content("5. ハーネス: HARNESS.md をエージェントと相談して書く", "5. ユーザーハーネス");
  txt(s, 0.5, 1.05, 9, 0.5, "草案はエージェントに出させ、人が削る。エージェントの案は「多くて甘い」。人の仕事は足すことではなく、削ることと厳しくすること。Plan モード(計画を人が承認してから実行 ◎)で頼む", { fontSize: 11.5 });
  code(s, 0.5, 1.65, 4.6, 2.1, "docs/PLAN.md を読んで、docs/customize/templates/HARNESS.md の\n雛形に沿って HARNESS.md の草案を書いて。\nフェーズは「1 セッションで 3 周以内に収束する大きさ」に分割。\n「実装:」は 1 行、ゲート条件は 3〜5 個。\nゲート条件は審査役が機械的に確認できる形(コマンドと期待する\n出力、比較する値、画面で見える要素)に限り、\n「正しく動く」「問題ない」は書かないで。\nPhase 0 は環境構築にして。", 8.5);
  table(s, 5.3, 1.65, 4.2, [
    ["悪い(確認できない)", "良い(確認できる)"],
    ["引数の処理が正しく動く", "--help に 4 つのサブコマンドが並び、未知の引数で終了コード 2(抜粋)"],
    ["設定の読み込みが前と同じ", "設定ファイル 12 項目の読み込み値が期待表と一致(表で比較)"],
    ["クラッシュしない", "未対応入力を 10 回連打してプロセスが生存(終了コード)"],
  ], [1.7, 2.5], { fontSize: 9.5 });
  table(s, 0.5, 3.95, 9, [
    ["見る所", "削る・直す"],
    ["フェーズの大きさ", "「実装:」行に「と」「および」が 2 つ以上あれば分割する"],
    ["条件の確認可能性", "上の表の「悪い」を「良い」に直す。直せない条件は未検証欄へ"],
    ["条件の数", "5 個を超えたら、テストで担保できるものをテストに移して外す"],
  ], [2.0, 7.0], { fontSize: 9.5 });
}
{
  const s = content("5. ハーネス: 導入チェック(陰性と陽性の両方)", "5. ユーザーハーネス");
  card(s, 0.5, 1.1, 4.3, 1.9, "陰性コントロール", "/phase-loop 0 で Phase 0 が PASS まで通る。\nFAIL が出たら、ゲート条件か審査役の指示が厳しすぎる。直してから次へ", 2);
  card(s, 5.2, 1.1, 4.3, 1.9, "陽性コントロール", "HARNESS.md 付録 B の壊し方を 1 つ入れる(例: 比較演算子を反転。テストは通る壊し方を選ぶ)。審査役が FAIL を出し、指摘がその箇所を指す", 3);
  txt(s, 0.5, 3.1, 9, 0.35, "ハーネスが「回る」ことと「検証する」ことは別。全フェーズが 1 周目で PASS していたら、審査していない", { fontSize: 11.5, bold: true });
  const checks = ["HARNESS.md のゲート条件が全フェーズ「確認できる」形", "/agent に implementer と reviewer が出る", "審査役が編集を断る。実装役がコマンドを実行できる", "/skills list に phase-loop が出る", "TEST_REPORT.md の環境 ID と外部 API の版が埋まっている", "/phase-loop 0 が PASS(陰性)。壊した実装で FAIL(陽性)", "phase-log.csv に Phase 0 の 1 行がある"];
  checks.forEach((c, i) => { const col = i % 2, row = Math.floor(i / 2); txt(s, 0.5 + col * 4.6, 3.55 + row * 0.4, 4.4, 0.36, "☐ " + c, { fontSize: 11 }); });
}
{
  const s = content("5. ハーネス: 実演で見る 3 点(導入編のバグ修正を Phase 1 に)", "5. ユーザーハーネス");
  code(s, 0.5, 1.05, 5.3, 4.05, "人: /phase-loop 1\n[オーケストレータ] Phase 1 を復唱: parse_version の 2 要素入力対応。\n  ゲート 3 件。implementer に委譲します。\n[implementer] 変更: src/version.cpp, tests/version_test.cpp(追加のみ)\n  ctest: 12/12 成功(前フェーズ 11)。未解決事項: なし\n[オーケストレータ] 審査前の差分を採取。reviewer に委譲します。\n[reviewer] tests/ 差分: 追加のみ。ctest 生出力: 12 passed, exit 0\n  ゲート 3: FAIL — \"1.2.\" で patch が未初期化。\n    再現: ./build/version_cli \"1.2.\"\n  陽性コントロール: 隔離コピーで if (parts == 2) を == 3 に変え、\n    ctest が 2 件落ちることを確認\n  VERDICT: FAIL\n[オーケストレータ] 審査後の差分は一致。指摘を implementer へ(2 周目)\n  ...\n[reviewer] 前回の再現手順を再実行: \"1.2.\" → invalid。VERDICT: PASS\n[オーケストレータ] PASS。TEST_REPORT.md と phase-log.csv の差分を提示。\n  コミットは指示をお待ちします。", 8.5);
  card(s, 6.0, 1.05, 3.5, 1.25, "① 審査役が自分で測った", "実装役の件数を写さず、ctest の生出力(件数・終了コード)が貼られている", 5, { bodySize: 10.5 });
  card(s, 6.0, 2.45, 3.5, 1.25, "② 陽性コントロールに方法がある", "「隔離コピーで壊してテストが落ちた」。「不正入力にエラーが返る」では検査にならない", 5, { bodySize: 10.5 });
  card(s, 6.0, 3.85, 3.5, 1.25, "③ FAIL に再現コマンドがある", "2 周目の再レビューは同じコマンドの再実行で閉じた。差分を読んだだけの PASS ではない", 5, { bodySize: 10.5 });
}
{
  const s = content("5. ハーネス: 共有の仕方", "5. ユーザーハーネス");
  const items = [["管理リポジトリに 1 回書いて、コピーで配る", "シンボリックリンクやサブモジュールは、エージェント環境の探索が実体を見るため使わない"], ["配布先で育つファイルは上書きしない", "HARNESS.md と TEST_REPORT.md は配った後にそのリポジトリで更新される。初回だけ置き、以後は配布対象から外す"], ["配った後に目で確認する", "/agent、/skills list、/instructions に出ること。見えない資産は存在しないのと同じ"], ["版を記録する", "アプリと CLI の版、配った日付、雛形の版を TEST_REPORT.md に。画面と資料が違っていたら画面が正しい"], ["他環境でも同じ HARNESS.md と phase-loop が使える", "スキルと指示は共通形式。実装役・審査役の定義だけは環境ごとに書き直す(付録 E)"]];
  items.forEach((it, i) => {
    chip(s, 0.5, 1.12 + i * 0.8, String(i + 1), 5, 0.36);
    txt(s, 1.0, 1.1 + i * 0.8, 8.5, 0.3, it[0], { fontSize: 12.5, bold: true });
    txt(s, 1.0, 1.42 + i * 0.8, 8.5, 0.42, it[1], { fontSize: 10.5, color: C.text2 });
  });
}

// ================================================================ まとめ
pres.addSection({ title: "まとめ" });
{
  const s = content("落とし穴: 章をまたいで多いもの", "まとめ");
  const pits = [["description が内容の要約", "発動しないときに直すのは description。本文ではない", 2], ["編集したのに効かない", "指示は開始時に読まれる。/new で始め直す", 1], ["ツール名の綴り違い", "知らない名前は黙って無視される。審査役が多くの権限を持っているかも。手元の環境で確かめる", 3], ["個人用の同名定義が勝つ", "~/.copilot/agents/ のエージェント、~/.copilot/skills/ のスキル", 3], ["MCP が読まれない(未信頼)", "リポジトリ側の設定はフォルダを信頼した後にだけ読まれる。/mcp list に無ければまずここ", 4], ["全フェーズが 1 周目 PASS", "審査していない。陽性コントロールをやり直す", 5], ["モデルを上げて解決しようとする", "3 周で通らないのはスコープの問題。分割する", 5], ["本体に実装の詳細を溜める", "消費が倍になる。本体は渡すだけ", 3], ["確認を飛ばす設定", "allowed-tools: shell や --allow-all-tools。人が最後の砦になれない", 2]];
  pits.forEach((p, i) => { const col = i % 3, row = Math.floor(i / 3); card(s, 0.5 + col * 3.05, 1.05 + row * 1.35, 2.9, 1.2, p[0], p[1], p[2], { headSize: 11.5, bodySize: 9.5 }); });
}
{
  const s = content("目で確認するコマンド集", "まとめ");
  table(s, 0.5, 1.05, 9, [
    ["目的", "セッション内", "非対話"],
    ["読まれた環境の全体", "/env", "—"],
    ["指示ファイルの一覧と無効化", "/instructions", "copilot instruction list"],
    ["スキルの一覧・詳細・再読み込み", "/skills list、/skills info <name>、/skills reload", "copilot skill list"],
    ["スキルの手動起動", "/<name> 引数", "—"],
    ["エージェントの一覧と選択", "/agent", "copilot --agent=<name> --prompt \"...\""],
    ["MCP の一覧・詳細・停止", "/mcp list、/mcp show <name>、/mcp disable <name>", "copilot mcp list"],
    ["承認のリセット", "/reset-allowed-tools", "—"],
    ["新しいセッション", "/new", "—"],
  ], [3.0, 3.6, 2.4], { fontSize: 10 });
  txt(s, 0.5, 4.6, 9, 0.5, "各章の末尾に同じ確認がある。配った後、見えない資産は存在しないのと同じ。スクリーンショット(SS-1〜11)は付録 F の撮影指定に従って手元の環境で撮る", { fontSize: 10.5, color: C.text2 });
}
{
  const s = content("対象外にしたものと、他のエージェント環境での対応", "まとめ");
  card(s, 0.5, 1.05, 4.3, 4.0, "対象外(付録 D)", "", 1);
  s.addText(bullets(["プロンプトファイル(.prompt.md): CLI・アプリで読まれない ◎ → スキルで代替", "フック: 基準は満たすが部品ではない。preToolUse で tests/ への書き込みを deny する、などは後の強化策", "プラグイン: 配布の手段。コピー配布を採るので扱わない", "Plan / Autopilot、クラウドサンドボックス、Canvas、Computer use、Automations、BYOK: UI 機能"], 10.5), { x: 0.7, y: 1.55, w: 3.9, h: 3.4, isTextBox: true, margin: 0, valign: "top", color: C.text1, objectName: "list" });
  table(s, 5.1, 1.05, 4.4, [
    ["機能", "Claude Code", "OpenCode", "Codex"],
    ["指示", "CLAUDE.md(無ければ AGENTS.md)", "AGENTS.md", "AGENTS.md(ネスト)"],
    ["スキル", "同じ仕様 .claude/skills", "同じ仕様 .agents/skills ほか", "同じ仕様 .agents/skills"],
    ["エージェント", ".claude/agents/*.md", ".opencode/agents/*.md", ".codex/agents/*.toml"],
    ["MCP", ".mcp.json(type: stdio|http)", "opencode.json mcp", "config.toml [mcp_servers]"],
    ["フック", "settings.json hooks", "プラグイン(JS/TS)", "hooks.json"],
  ], [0.9, 1.3, 1.2, 1.0], { fontSize: 8.5 });
  txt(s, 5.1, 3.95, 4.4, 1.1, "持ち運びの指針: スキルは .github/skills/ を正にして .agents/skills/ にコピー。指示は AGENTS.md を正に。MCP の .mcp.json は Copilot と Claude Code で type の値が違うので分ける ▲。エージェントは本文を持ち運び、frontmatter は環境ごとに", { fontSize: 9.5, color: C.text2 });
}
{
  const s = pres.addSlide({ masterName: "TITLE", sectionTitle: "まとめ" });
  s.addText("次の一歩: Phase 0 を 1 周回す", { placeholder: "title" });
  s.addText("1. AGENTS.md を置く(第 1 章の例)   2. 雛形をコピーして HARNESS.md をエージェントと相談して書く(第 5.4 節)\n3. /phase-loop 0 で陰性、壊して陽性(第 5.4 節 Step 5)   4. 週 1 回、HARNESS.md 付録 A の兆候を見る", { placeholder: "body" });
  s.addText("本文: docs/customize/README.md から各章へ。雛形: docs/customize/templates/", { x: 0.6, y: 4.6, w: 8.8, h: 0.4, fontSize: 11, color: C.background2, isTextBox: true, margin: 0, objectName: "note" });
  n++;
}

(async () => {
  await pres.writeFile({ fileName: OUT });
  if (APPLY && fs.existsSync(APPLY)) {
    const { applyTheme } = require(APPLY);
    await applyTheme(OUT, THEME);
  }
  console.log("wrote", OUT, "slides:", n);
})();
