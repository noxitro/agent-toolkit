// docs/customize の入門版(README と 01〜05)の説明会用スライド(customize-guide.pptx)を生成する。
// 実行: NODE_PATH=<pptxgenjs を入れた node_modules> node docs/customize/slides/_build.js
// 本文(Markdown)が正で、ここは要点の写し。詳細資料のスライドは _build-advanced.js。
const path = require("path");
const fs = require("fs");
const pptxgen = require("pptxgenjs");

const HERE = __dirname;
const OUT = path.join(HERE, "customize-guide.pptx");
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
// 章の色(本文の図・詳細版のスライドと揃える): 1 指示=青, 2 スキル=緑, 3 エージェント=橙, 4 MCP=紫, 5 組み合わせ=琥珀
const pres = new pptxgen();
pres.layout = "LAYOUT_16x9"; // 10 x 5.625 in
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
pres.title = "エージェントのカスタマイズ入門";
pres.author = "配布資料";
const C = pres.SchemeColor;
const CH_HEX = { 1: "1E88E5", 2: "43A047", 3: "FB8C00", 4: "8E24AA", 5: "F9A825" };
// 見出しの文字色。琥珀は白地で薄いので濃くする。テーマ色(SchemeColor)は既定テーマで別の色になるので使わない
const CH = { 1: "1565C0", 2: "2E7D32", 3: "E65100", 4: "7B1FA2", 5: "B26A00" };
const TINT = { 1: "E3F2FD", 2: "E8F5E9", 3: "FFF3E0", 4: "F3E5F5", 5: "FFFDE7" };
const GRAY = "9AA5B1";

const FOOTER = "エージェントのカスタマイズ入門";

pres.defineSlideMaster({
  title: "TITLE",
  background: { color: THEME.colors.dk1 },
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.6, y: 1.5, w: 8.8, h: 1.4, fontSize: 32, bold: true, color: C.background1, align: "left", valign: "bottom", margin: 0 } } },
    { placeholder: { options: { name: "body", type: "body", x: 0.6, y: 3.05, w: 8.8, h: 1.3, fontSize: 15, color: C.background2, valign: "top", margin: 0 } } },
  ],
});
pres.defineSlideMaster({
  title: "SECTION",
  background: { color: THEME.colors.dk1 },
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.6, y: 2.2, w: 8.8, h: 1.0, fontSize: 32, bold: true, color: C.background1, align: "left", valign: "middle", margin: 0 } } },
    { placeholder: { options: { name: "body", type: "body", x: 0.6, y: 3.25, w: 8.8, h: 1.2, fontSize: 16, color: C.background2, valign: "top", margin: 0 } } },
    { text: { text: FOOTER, options: { x: 0.5, y: 5.2, w: 7, h: 0.3, fontSize: 9, color: C.text2, margin: 0 } } },
  ],
});
pres.defineSlideMaster({
  title: "CONTENT",
  background: { color: THEME.colors.lt1 },
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.5, y: 0.3, w: 9, h: 0.6, fontSize: 24, bold: true, color: C.text1, align: "left", valign: "middle", margin: 0 } } },
    { text: { text: FOOTER, options: { x: 0.5, y: 5.25, w: 7, h: 0.25, fontSize: 8, color: C.text2, margin: 0 } } },
  ],
  slideNumber: { x: 9.1, y: 5.25, w: 0.5, h: 0.25, fontSize: 8, color: C.text2, align: "right" },
});

// ---------------------------------------------------------------- helpers
let n = 0;
function content(title, section, notes) {
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: section });
  s.addText(title, { placeholder: "title" });
  if (notes) s.addNotes(notes);
  n++;
  return s;
}
function txt(s, x, y, w, h, text, o = {}) {
  s.addText(text, Object.assign({ x, y, w, h, fontSize: 13, color: C.text1, isTextBox: true, margin: 0, valign: "top", objectName: "text" }, o));
}
function card(s, x, y, w, h, head, body, ch, o = {}) {
  s.addShape(pres.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.08, fill: { color: o.fill || TINT[ch] }, line: { color: CH_HEX[ch], width: 1 }, objectName: "card" });
  if (head) s.addText(head, { x: x + 0.15, y: y + 0.12, w: w - 0.3, h: 0.36, fontSize: o.headSize || 15, bold: true, color: CH[ch], isTextBox: true, margin: 0, valign: "top", objectName: "card-head" });
  if (body) s.addText(body, { x: x + 0.15, y: y + (head ? 0.55 : 0.14), w: w - 0.3, h: h - (head ? 0.65 : 0.28), fontSize: o.bodySize || 12.5, color: C.text1, isTextBox: true, margin: 0, valign: "top", paraSpaceAfter: 4, objectName: "card-body" });
}
function plain(s, x, y, w, h, head, body, o = {}) {
  s.addShape(pres.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.08, fill: { color: THEME.colors.lt2 }, line: { color: "D9E2EC", width: 1 }, objectName: "card" });
  if (head) s.addText(head, { x: x + 0.15, y: y + 0.12, w: w - 0.3, h: 0.36, fontSize: o.headSize || 15, bold: true, color: C.text1, isTextBox: true, margin: 0, valign: "top", objectName: "card-head" });
  if (body) s.addText(body, { x: x + 0.15, y: y + (head ? 0.55 : 0.14), w: w - 0.3, h: h - (head ? 0.65 : 0.28), fontSize: o.bodySize || 12.5, color: C.text1, isTextBox: true, margin: 0, valign: "top", paraSpaceAfter: 4, objectName: "card-body" });
}
function chip(s, x, y, label, ch, d = 0.5) {
  s.addShape(pres.ShapeType.ellipse, { x, y, w: d, h: d, fill: { color: CH_HEX[ch] }, line: { color: CH_HEX[ch] }, objectName: "chip" });
  s.addText(label, { x, y, w: d, h: d, fontSize: 16, bold: true, color: C.background1, align: "center", valign: "middle", isTextBox: true, margin: 0, objectName: "chip-label" });
}
function bullets(lines, size = 13) {
  return lines.map((t, i) => ({ text: t, options: { bullet: true, breakLine: i < lines.length - 1, fontSize: size, paraSpaceAfter: 6 } }));
}
function list(s, x, y, w, h, lines, size = 13) {
  s.addText(bullets(lines, size), { x, y, w, h, isTextBox: true, margin: 0, valign: "top", color: C.text1, objectName: "list" });
}
function table(s, x, y, w, rows, colW, o = {}) {
  const fs = o.fontSize || 12;
  const data = rows.map((r, i) => r.map((c) => ({
    text: c,
    options: i === 0
      ? { bold: true, color: THEME.colors.lt1, fill: { color: o.headFill || THEME.colors.accent1 }, fontSize: fs, valign: "middle" }
      : { color: THEME.colors.dk1, fill: { color: i % 2 ? THEME.colors.lt1 : THEME.colors.lt2 }, fontSize: fs, valign: "middle" },
  })));
  s.addTable(data, { x, y, w, colW, border: { type: "solid", color: "D9E2EC", pt: 0.75 }, margin: 0.07, autoPage: false, objectName: "table", rowH: o.rowH });
}
function code(s, x, y, w, h, text, size = 11) {
  s.addShape(pres.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.06, fill: { color: "F7F9FB" }, line: { color: "D9E2EC", width: 1 }, objectName: "code-bg" });
  s.addText(text, { x: x + 0.15, y: y + 0.1, w: w - 0.3, h: h - 0.2, fontSize: size, fontFace: "Consolas", color: C.text1, isTextBox: true, margin: 0, valign: "top", objectName: "code" });
}
function label(s, x, y, w, text, o = {}) {
  s.addText(text, Object.assign({ x, y, w, h: 0.3, fontSize: 11, bold: true, color: C.text2, isTextBox: true, margin: 0, valign: "middle", objectName: "label" }, o));
}
function arrow(s, x, y, w, h, color = GRAY, o = {}) {
  s.addShape(pres.ShapeType.line, { x, y, w, h, flipH: !!o.flipH, flipV: !!o.flipV, line: { color, width: 1.75, endArrowType: o.noHead ? undefined : "triangle" }, objectName: "arrow" });
}
function box(s, x, y, w, h, text, fill, lineColor, o = {}) {
  s.addShape(pres.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.08, fill: { color: fill }, line: { color: lineColor, width: 1.25 }, objectName: "box" });
  s.addText(text, { x: x + 0.08, y, w: w - 0.16, h, fontSize: o.size || 13, bold: !!o.bold, color: o.color || C.text1, align: "center", valign: "middle", isTextBox: true, margin: 0, objectName: "box-text" });
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
// 各章の「作る・確かめる・コツ・育て方」を同じ形で並べる
function howto(s, ch, ask, check, tips, grow) {
  label(s, 0.5, 1.05, 4.4, "① エージェントに頼んで下書きを出してもらう");
  code(s, 0.5, 1.4, 4.4, 1.55, ask, 12);
  label(s, 0.5, 3.1, 4.4, "② 効いているか確かめる");
  plain(s, 0.5, 3.45, 4.4, 1.6, "", check, { bodySize: 13 });
  card(s, 5.2, 1.05, 4.3, 2.55, "コツは 3 つ", "", ch);
  list(s, 5.4, 1.65, 3.95, 1.9, tips, 14.5);
  plain(s, 5.2, 3.75, 4.3, 1.3, "育て方", grow, { bodySize: 13 });
}

// ================================================================ 0. はじめに
pres.addSection({ title: "はじめに" });
{
  const s = pres.addSlide({ masterName: "TITLE", sectionTitle: "はじめに" });
  s.addText("エージェントのカスタマイズ入門", { placeholder: "title" });
  s.addText("GitHub Copilot などのエージェントに\n「このリポジトリではこうしてね」を覚えさせる 4 つの部品", { placeholder: "body" });
  [1, 2, 3, 4, 5].forEach((i, k) => s.addShape(pres.ShapeType.ellipse, { x: 0.6 + k * 0.5, y: 4.6, w: 0.32, h: 0.32, fill: { color: CH_HEX[i] }, line: { color: CH_HEX[i] }, objectName: "dot" }));
  s.addText("読む資料: docs/copilot-harness/customize/README.md(このスライドは要点の写し)", { x: 3.3, y: 4.6, w: 6.2, h: 0.32, fontSize: 10.5, color: C.background2, isTextBox: true, margin: 0, valign: "middle", objectName: "note" });
  s.addNotes("30 分の説明会用。細かい仕様には触れない。質問が細部に及んだら「詳細資料・上級者向け(advanced/)」を案内する。");
  n++;
}
{
  const s = content("最初に覚えることは 3 つだけ", "はじめに", "3 つ目を一番強調する。最初から完璧なものを書こうとしなくてよい。");
  const items = [
    [1, "部品は 4 つだけ", "指示・スキル・\nカスタムエージェント・MCP"],
    [2, "中身はただのテキスト", "決まった場所に Markdown を置けば、\nエージェントが読んでくれる"],
    [5, "自分で全部書かなくていい", "エージェントに下書きを頼み、\n使いながら一緒に直していく。\n最初から完璧を目指さない"],
  ];
  items.forEach(([ch, head, body], k) => {
    const x = 0.5 + k * 3.05;
    s.addShape(pres.ShapeType.roundRect, { x, y: 1.2, w: 2.9, h: 3.7, rectRadius: 0.1, fill: { color: TINT[ch] }, line: { color: CH_HEX[ch], width: 1 }, objectName: "card" });
    chip(s, x + 0.2, 1.4, String(k + 1), ch, 0.7);
    s.addText(head, { x: x + 0.2, y: 2.3, w: 2.5, h: 0.75, fontSize: 17, bold: true, color: CH[ch], isTextBox: true, margin: 0, valign: "top", objectName: "card-head" });
    s.addText(body, { x: x + 0.2, y: 3.15, w: 2.5, h: 1.6, fontSize: 13, color: C.text1, isTextBox: true, margin: 0, valign: "top", objectName: "card-body" });
  });
}
{
  const s = content("4 つの部品", "はじめに", "表の「いつ読まれる」の列がポイント。指示は毎回、スキルは必要なときだけ。");
  const parts = [
    [1, "指示", "いつも守ってほしい\n約束ごと", "毎回", "AGENTS.md"],
    [2, "スキル", "特定の作業の\n手順書", "その作業を\n頼んだとき", ".github/skills/\n<名前>/SKILL.md"],
    [3, "カスタム\nエージェント", "役割を決めた\n助っ人", "呼んだとき", ".github/agents/\n<名前>.agent.md"],
    [4, "MCP", "外のサービスと\nつなぐ口", "そのサービスを\n使うとき", "画面かコマンドで\n追加"],
  ];
  label(s, 0.5, 2.15, 1.1, "ひとことで");
  label(s, 0.5, 3.15, 1.1, "いつ読まれる");
  label(s, 0.5, 4.15, 1.1, "置き場");
  parts.forEach(([ch, name, what, when, where], k) => {
    const x = 1.65 + k * 2.0;
    s.addShape(pres.ShapeType.roundRect, { x, y: 1.1, w: 1.85, h: 3.95, rectRadius: 0.1, fill: { color: TINT[ch] }, line: { color: CH_HEX[ch], width: 1 }, objectName: "card" });
    s.addText(name, { x: x + 0.1, y: 1.2, w: 1.65, h: 0.7, fontSize: 15, bold: true, color: CH[ch], align: "center", valign: "middle", isTextBox: true, margin: 0, objectName: "card-head" });
    s.addText(what, { x: x + 0.1, y: 2.0, w: 1.65, h: 0.65, fontSize: 12.5, color: C.text1, align: "center", valign: "middle", isTextBox: true, margin: 0, objectName: "card-body" });
    s.addText(when, { x: x + 0.1, y: 3.0, w: 1.65, h: 0.65, fontSize: 12.5, bold: true, color: C.text1, align: "center", valign: "middle", isTextBox: true, margin: 0, objectName: "card-body" });
    s.addText(where, { x: x + 0.1, y: 4.0, w: 1.65, h: 0.65, fontSize: 10.5, fontFace: "Consolas", color: C.text1, align: "center", valign: "middle", isTextBox: true, margin: 0, objectName: "card-body" });
  });
}
{
  const s = content("どれを使うか迷ったら", "はじめに", "左から順に問う。どれにも当てはまらなければ、何も作らずにその場で頼めば十分。");
  const qs = [
    [1, "毎回守って\nほしい?", "指示"],
    [2, "決まった作業の\n手順?", "スキル"],
    [3, "役割ごと\n分けたい?", "カスタム\nエージェント"],
    [4, "外のサービスに\n触りたい?", "MCP"],
  ];
  const W = 1.45, G = 0.43;
  qs.forEach(([ch, q, a], k) => {
    const x = 0.5 + k * (W + G);
    box(s, x, 1.3, W, 1.0, q, THEME.colors.lt2, "BCCCDC", { size: 12.5 });
    arrow(s, x + W / 2, 2.3, 0, 0.85, CH_HEX[ch]);
    label(s, x + W / 2 + 0.06, 2.55, 0.6, "はい", { color: CH[ch] });
    box(s, x, 3.15, W, 1.0, a, CH_HEX[ch], CH_HEX[ch], { size: 14, bold: true, color: C.background1 });
    arrow(s, x + W, 1.8, G, 0); // 最後の「いいえ」は右端の箱へ
    s.addText("いいえ", { x: x + W, y: 1.5, w: G, h: 0.25, fontSize: 9, color: C.text2, align: "center", isTextBox: true, margin: 0, objectName: "label" });
  });
  const x5 = 0.5 + 4 * (W + G);
  box(s, x5, 1.3, W, 1.0, "何も作らず、\nその場で頼めば\n十分", "FFFFFF", GRAY, { size: 12 });
  txt(s, 0.5, 4.45, 9, 0.5, "迷いやすいのは指示とスキル。「いつも」なら指示、「〜するときは」ならスキル。", { fontSize: 13, color: C.text2 });
}

// ================================================================ 1. 指示
section(1, "指示", "いつも守ってほしい約束ごと");
{
  const s = content("1. 指示: リポジトリの約束ごとメモ", "1. 指示", "新人に渡すメモと同じ、と説明する。AGENTS.md は多くのエージェントが読む共通の名前。");
  card(s, 0.5, 1.05, 3.6, 3.95, "これは何", "", 1);
  list(s, 0.7, 1.6, 3.25, 3.3, [
    "リポジトリのいちばん上に AGENTS.md を置く",
    "エージェントは会話を始めるたびに、最初にそれを読む",
    "新しく入った人に渡す「約束ごとメモ」と同じ",
    "Copilot 以外の多くのエージェントも読む共通の名前",
  ], 14.5);
  label(s, 4.4, 1.05, 5.1, "例: AGENTS.md");
  code(s, 4.4, 1.4, 5.1, 3.6, "# このリポジトリの約束\n\n- ビルドは `cmake --build build`、\n  テストは `ctest --test-dir build`。\n  両方通ってから「完了」と言う。\n- 返事は日本語で。\n- コミットはしない。\n  人が確認してからする。\n- 分からないことは推測で進めず、\n  質問する。", 13);
}
{
  const s = content("1. 指示: 作る・確かめる・コツ", "1. 指示", "「ファイルを直したら新しい会話で」は必ず伝える。開いたままの会話には反映されない。");
  howto(s, 1,
    "このリポジトリを読んで、AGENTS.md の\n下書きを作って。ビルドとテストのコマンド、\n触ってはいけない場所、報告のしかたを\n短く。20 行以内で。",
    "新しい会話を開いて、約束に反することを頼む(例:「コミットして」)。断られたら効いている。\nファイルを直したら、新しい会話で試す。",
    ["短く。毎回読まれるので、長いほど遅く・高くなる", "「いつも」のことだけ。手順はスキルへ", "同じことを 2 か所に書かない"],
    "同じ間違いを 2 回されたら 1 行足す。守らなくてよくなった行は消す。");
}

// ================================================================ 2. スキル
section(2, "スキル", "特定の作業の手順書");
{
  const s = content("2. スキル: 必要なときだけ読まれる手順書", "2. スキル", "普段は名前と説明文だけが見えている。だから数があっても会話が重くなりにくい。");
  card(s, 0.5, 1.05, 3.6, 2.3, "これは何", "", 2);
  list(s, 0.7, 1.6, 3.25, 1.7, [
    "「この作業はこうやる」の手順書",
    "普段は名前と説明文だけを見ていて、依頼が合ったときに中身を読む",
    "共通の規格。他のエージェントでも使える",
  ], 13.5);
  label(s, 0.5, 3.5, 3.6, "置き場(フォルダ名 = スキルの名前)");
  code(s, 0.5, 3.85, 3.6, 1.2, ".github/skills/\n└── build-and-test/\n    └── SKILL.md", 11);
  label(s, 4.4, 1.05, 5.1, "例: SKILL.md");
  code(s, 4.4, 1.4, 5.1, 3.65, "---\nname: build-and-test\ndescription: ビルドやテストを頼まれたとき、\n  またはビルドが失敗した原因を調べるときに使う\n  (例:「ビルドして」「テストを回して」)。\n  新しいテストを書く作業には使わない。\n---\n\n# ビルドとテスト\n1. cmake --build build を実行する。\n   失敗したら最後の 20 行を見せて止まる。\n2. ctest で成功と失敗の数を報告する。\n3. テストのコードは変えない。", 12);
}
{
  const s = content("2. スキル: いちばん大事なのは説明文(description)", "2. スキル", "呼ばれないときに本文を直す人が多い。直すのは説明文。");
  txt(s, 0.5, 1.05, 9, 0.5, "説明文は「中身の要約」ではなく、どんな依頼のときに使うかを書く。", { fontSize: 15, bold: true });
  table(s, 0.5, 1.7, 9, [
    ["よくない(中身の要約)", "よい(使う場面)"],
    ["ビルドとテストの手順", "ビルドやテストを頼まれたときに使う(例:「ビルドして」)。\n新しいテストを書く作業には使わない。"],
  ], [3.0, 6.0], { fontSize: 13, rowH: [0.4, 0.9] });
  card(s, 0.5, 3.3, 4.4, 1.75, "書くこと", "", 2);
  list(s, 0.7, 3.85, 4.05, 1.15, ["普段の頼み方をそのまま入れる", "使わない場面も 1 つ書く(似たスキルと取り合わない)"], 12.5);
  plain(s, 5.1, 3.3, 4.4, 1.75, "呼ばれないときは", "直すのは本文ではなく説明文。\n呼ばれなかった頼み方を説明文に足す。", { bodySize: 12.5 });
}
{
  const s = content("2. スキル: 作る・確かめる・コツ", "2. スキル", "/スキル名 で直接呼べることも見せる。");
  howto(s, 2,
    "「〇〇」の作業をスキルにしたい。\n.github/skills/〇〇/SKILL.md を作って。\ndescription には、どんな依頼のときに\n使うかと、使わない場面を書いて。\n本文は手順を短く。",
    "使ってほしい頼み方で依頼し、スキルを読み込んだ表示が出れば OK。\n/スキル名 で直接呼べる。一覧はアプリの Customize → Skills か、CLI の /skills list。",
    ["1 つのスキルに 1 つの作業", "増やしすぎない。使っていないものは消す", "毎回守ってほしいことなら指示へ"],
    "呼ばれなかったら、その頼み方を説明文に足す。呼ばれなくていいのに呼ばれたら「〜には使わない」を足す。");
}

// ================================================================ 3. カスタムエージェント
section(3, "カスタムエージェント", "役割を決めた助っ人");
{
  const s = content("3. カスタムエージェント: 役割を決めた助っ人", "3. カスタムエージェント", "tools に edit を入れていないので、このレビュー担当はファイルを直せない。ここが第 5 章の「確かめる役」につながる。");
  card(s, 0.5, 1.05, 3.6, 2.6, "これは何", "", 3);
  list(s, 0.7, 1.6, 3.25, 2.0, [
    "役割・守ること・使える道具を決めたエージェント",
    "自分で選んで話しかけるか、いつものエージェントに任せてもらう",
    "任された側は別の会話で動く",
  ], 13.5);
  plain(s, 0.5, 3.8, 3.6, 1.25, "使い方", "/agent で一覧から選ぶか、\n依頼の中で名前を出す(「reviewer に確認させて」)", { bodySize: 12 });
  label(s, 4.4, 1.05, 5.1, "例: .github/agents/reviewer.agent.md");
  code(s, 4.4, 1.4, 5.1, 2.75, "---\nname: reviewer\ndescription: 変更を確かめて、合格か不合格かを\n  証拠付きで返すレビュー担当。コードは直さない。\ntools: [\"read\", \"search\", \"execute\"]\n---\nあなたはレビュー担当です。\n- コードを直さない。直したくなったら不合格にする。\n- 「動きました」を信じず、自分で実行して確かめる。\n- 最後に「合格」か「不合格」を 1 行で書く。", 11.5);
  card(s, 4.4, 4.3, 5.1, 0.75, "", "tools = 使える道具。読む・探す・実行するだけで、書き換える道具(edit)を渡していない", 3, { bodySize: 11.5 });
}
{
  const s = content("3. カスタムエージェント: 作る・確かめる・コツ", "3. カスタムエージェント", "何でも分けない、を強調する。分けるほど時間とコストが増える。");
  howto(s, 3,
    "コードを直さずに確認だけするレビュー担当\nのカスタムエージェントを\n.github/agents/reviewer.agent.md に作って。\n自分でビルドとテストを実行して確かめ、\n最後に合格か不合格かを書く役にして。",
    "/agent の一覧に出るか。\nreviewer を選んで「このファイルの 1 行を直して」と頼み、直さずに断るか。",
    ["役割は 1 つに絞る", "確かめる役には書き換える道具を渡さない", "何でも分けない。普段はいつものエージェントで十分"],
    "見落としがあったら「〜も確認する」を 1 行足す。");
}

// ================================================================ 4. MCP
section(4, "MCP", "外のサービスとつなぐ口");
{
  const s = content("4. MCP: 外のサービスとつなぐ口", "4. MCP", "GitHub には最初からつながっている。コマンドで済むものは MCP にしない。");
  card(s, 0.5, 1.05, 4.4, 1.35, "これは何", "Issue 管理・ブラウザ・データベース・チームの文書検索など、普段は触れないものに手を届かせる。共通の規格。", 4, { bodySize: 12 });
  card(s, 0.5, 2.55, 4.4, 2.5, "まず知っておくこと", "", 4);
  list(s, 0.7, 3.1, 4.05, 1.9, [
    "GitHub にはもうつながっている。設定しなくても Issue や PR を読める",
    "コマンドで済むなら MCP は要らない。git や gh を使わせるほうが簡単で、何をしたかも見える",
  ], 12.5);
  plain(s, 5.1, 1.05, 4.4, 1.35, "追加のしかた", "アプリ: Customize → MCP から探して入れる\nCLI: /mcp add と打って質問に答える(一覧は /mcp list)", { bodySize: 11.5 });
  plain(s, 5.1, 2.55, 4.4, 2.5, "気をつけること", "", {});
  list(s, 5.3, 3.1, 4.05, 1.9, [
    "信頼できる提供元のものだけ入れる",
    "確認の画面を読んでから許可する。「全部許可」にしない",
    "パスワードやトークンを、リポジトリに入れるファイルに書かない",
    "Issue や Web ページに書かれた指示には従わせない",
  ], 12);
}

// ================================================================ 5. 組み合わせる
section(5, "組み合わせる", "作る役と確かめる役で回す(ユーザーハーネス)");
{
  const s = content("5. 考え方: 「できました」をそのまま信じない", "5. 組み合わせる", "ここまでの部品を組み合わせただけ。新しい仕組みを覚える必要はない。");
  const ideas = [
    ["作る役と確かめる役", "分けておく。確かめる役は自分で実行して確かめ、コードは直さない"],
    ["合格の条件を先に書く", "「正しく動く」ではなく、誰が見ても同じ判定になる形で"],
    ["作業を小さく区切る", "1 区切り(フェーズ)ずつ。合格したら次へ"],
  ];
  ideas.forEach(([h, b], k) => card(s, 0.5 + k * 3.05, 1.05, 2.9, 1.55, `${k + 1}. ${h}`, b, 5, { headSize: 13.5, bodySize: 13 }));
  box(s, 0.5, 3.0, 2.5, 0.85, "作る役が実装する", TINT[3], CH_HEX[3], { size: 13, bold: true });
  box(s, 3.55, 3.0, 2.7, 0.85, "確かめる役が\n自分で実行して判定", TINT[3], CH_HEX[3], { size: 13, bold: true });
  box(s, 6.8, 3.0, 2.7, 0.85, "人が確認してコミット\n→ 次のフェーズへ", TINT[1], CH_HEX[1], { size: 13, bold: true });
  arrow(s, 3.0, 3.42, 0.55, 0);
  arrow(s, 6.25, 3.42, 0.55, 0, "43A047");
  label(s, 6.25, 3.05, 0.6, "合格", { color: "43A047", align: "center" });
  // 不合格は作る役へ戻す
  arrow(s, 4.9, 3.85, 0, 0.45, "E53935", { noHead: true });
  arrow(s, 1.75, 4.3, 3.15, 0, "E53935", { noHead: true });
  arrow(s, 1.75, 3.85, 0, 0.45, "E53935", { flipV: true });
  label(s, 2.2, 4.35, 2.6, "不合格: 直してもう一度", { color: "E53935", align: "center" });
  txt(s, 5.4, 4.35, 4.1, 0.6, "不合格が 3 回続いたら止めて、人が作業を小さく分け直す。", { fontSize: 12.5, bold: true });
}
{
  const s = content("5. 使うものと始め方", "5. 組み合わせる", "雛形は templates/ にある。{{ }} を埋めるだけ。HARNESS.md だけはエージェントと相談して埋める。");
  table(s, 0.5, 1.05, 5.0, [
    ["ファイル", "役目", "置き場"],
    ["HARNESS.md", "フェーズと合格条件", "いちばん上"],
    ["implementer.agent.md", "作る役", ".github/agents/"],
    ["reviewer.agent.md", "確かめる役", ".github/agents/"],
    ["phase-loop/SKILL.md", "1 周の進め方", ".github/skills/"],
    ["TEST_REPORT.md", "結果の記録", "docs/"],
  ], [1.95, 1.6, 1.45], { fontSize: 11, rowH: 0.42 });
  txt(s, 0.5, 3.85, 5.0, 0.7, "雛形は templates/ にある。{{ }} の所を埋めて使う。", { fontSize: 12, color: C.text2 });
  card(s, 5.8, 1.05, 3.7, 4.0, "始め方", "", 5);
  const steps = ["雛形を置き場にコピーする", "HARNESS.md はエージェントと相談して埋める", "出てきた案を人が見て、減らす・厳しくする", "/phase-loop 0 で Phase 0 を 1 周回す"];
  steps.forEach((t, k) => {
    chip(s, 6.0, 1.65 + k * 0.82, String(k + 1), 5, 0.42);
    txt(s, 6.55, 1.65 + k * 0.82, 2.8, 0.75, t, { fontSize: 12.5, valign: "top" });
  });
}
{
  const s = content("5. 合格の条件の書き方と、大事な約束", "5. 組み合わせる", "エージェントが出す合格条件は甘くなりがち。人の仕事は足すことではなく、減らすことと厳しくすること。");
  table(s, 0.5, 1.05, 9, [
    ["よくない(人によって判定が変わる)", "よい(誰が見ても同じ)"],
    ["正しく動く", "--help を実行すると 4 つのコマンド名が表示される"],
    ["前と同じ結果になる", "設定 12 項目の読み込み結果が、期待する表と一致する"],
    ["クラッシュしない", "おかしな入力を 10 回与えても、プログラムが終了しない"],
  ], [3.2, 5.8], { fontSize: 13.5, rowH: 0.42 });
  const rules = [
    ["確かめる役は直さない", "コードを直したくなったら不合格にする"],
    ["確かめる役は自分で実行する", "作る役の報告を信じない"],
    ["3 回でだめなら人が分ける", "モデルを変えても解決しないことが多い"],
  ];
  rules.forEach(([h, b], k) => card(s, 0.5 + k * 3.05, 3.45, 2.9, 1.5, h, b, 5, { headSize: 14, bodySize: 13 }));
}

// ================================================================ まとめ
pres.addSection({ title: "まとめ" });
{
  const s = pres.addSlide({ masterName: "TITLE", sectionTitle: "まとめ" });
  s.addText("次の一歩: まず AGENTS.md を 1 つ置く", { placeholder: "title" });
  s.addText("エージェントに下書きを頼む → 読んで直す → 新しい会話で確かめる。\nあとは困ったときに 1 行ずつ足していけば十分です。", { placeholder: "body" });
  s.addText("慣れてきたら: 詳細資料・上級者向け(advanced/)で、細かい仕様・うまくいかないときの原因・設計の理由を必要な章だけ引く", { x: 0.6, y: 4.5, w: 8.8, h: 0.6, fontSize: 11.5, color: C.background2, isTextBox: true, margin: 0, objectName: "note" });
  s.addNotes("最後に「全部を覚える必要はない。エージェントと一緒に育てる」を繰り返す。");
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
