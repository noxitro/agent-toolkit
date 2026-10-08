---
name: root-cause-analysis
description: 'Use this skill whenever the user asks to diagnose why something failed, find the root cause of an incident, conduct a post-mortem, analyze a problem or defect, distinguish symptoms from causes, or apply 5 Whys or Fishbone analysis. Trigger on phrases like "why did this happen", "root cause", "post-mortem", "5 whys", "fishbone", "what caused this", "diagnose the failure", "why did it fail", "underlying cause". Do NOT trigger for general problem solving (use business-os), refining existing plans (use idea-refiner), or content quality audits (use content-quality-auditor). 日本語での依頼例: 「原因を分析して」「なぜなぜ分析」「特性要因図(フィッシュボーン)を作って」「根本原因は何か」。障害報告書(ポストモーテム)の文書全体を書く依頼には使わない(incident-postmortem を使う)。'
---

## Microsoft 365 Copilot で使うときの読み替え

<!-- この節は m365-org-skills が追加したもので、原文には無い。原文は下の「原文」以降。 -->

この節は、下の原文(英語)より優先する。原文は GitHub Copilot や Copilot Studio 向けに書かれているため、次のとおり読み替える。

- 回答とファイルは日本語で書く。見出しや表の構成は原文のテンプレートに従い、見出しは日本語に訳してよい。コード・SQL・識別子は原文のまま。
- このエージェントはリポジトリやフォルダに保存できない。原文の「`docs/...` に保存する」などの指示は、「Markdown ファイルを作り、ダウンロードできる形で返す」と読み替える。ファイル名は、下の「このスキルでの読み替え」に指定があればそれを、無ければ原文の保存先のファイル名を使う。チャットには要点だけを書き、本文はファイルで渡す。
- `${input:...}` や `${selection}` は、ユーザーのメッセージ・添付ファイル・貼り付けた文章から取る。足りなければ質問する。
- 社内システム・社内サイト・Slack・PagerDuty・課題管理ツールなどには接続できない。原文がそれらを参照するよう求めても、ユーザーが添付・貼り付けた範囲だけを使う。
- 資料に無いことを作らない。担当者・期限・時刻・数値だけでなく、理由・原因・影響・却下の理由も同じ。原文が「必ず埋める」と求める欄でも、資料から言えなければ「要確認(TBD)」と書く。
- 添付にパスワード・トークン・鍵・接続文字列、業務に不要な個人情報(電話番号・住所など)があっても書き写さない。見つけたことだけを伝える。参加者名や担当者名は、成果物に必要なら書いてよい。

### このスキルでの読み替え
- 原文が名前を挙げている `business-os` `idea-refiner` `content-quality-auditor` はこのエージェントに無い。無視してよい。
- 障害の報告書(ポストモーテム)全体を書く依頼は `incident-postmortem` を使う。このスキルは「なぜ起きたか」の分析に使う。
- 特性要因図は `assets/fishbone-template.html` を編集し、`fishbone_<短い題名>.html` としてファイルで返す。札は原文どおり英語の CONFIRMED / UNVERIFIED / DISPROVEN を使い、要因の本文は日本語で書く(チャットでは「確認済み・未確認・否定」と説明してよい)。

## 原文

# Root Cause Analysis

Guide the user through structured problem diagnosis to move from observed symptoms to the true underlying cause, using repeatable techniques that prevent guessing or stopping at surface-level fixes.

## Instructions

1. **Lock the problem statement**
   - State the exact symptom or failure in one sentence.
   - Capture when it occurred, where, and who or what was affected.
   - Do not allow vague wording like "it broke" or "performance is bad."

2. **Map the symptom chain**
   - List every observed symptom as a fact, not a hypothesis.
   - For each symptom, ask: "What could produce this?"
   - Keep asking "why" at least three levels deep before proposing any cause.

3. **Apply 5 Whys**
   - Start from the problem statement.
   - Ask "why" repeatedly, recording each answer.
   - Stop when you reach a cause that, if fixed, would prevent the symptom from recurring.
   - If you reach a cause that is a contributing factor rather than a fixable origin, keep going.
   - Load `references/rca-methods.md` if the problem is complex or the user asks for a specific technique.

 4. **Build a Fishbone diagram**
    - Categorize potential causes across: People, Process, Technology, Data, Environment, Management.
    - For each category, list specific contributing factors backed by evidence the user can confirm.
    - Do not invent facts; if a factor is uncertain, mark it as unverified.
    - Use `assets/fishbone-template.html` to structure the diagram. Open the template, replace the placeholder text in each category branch with the contributing factors identified above, and return the filled-in HTML so the user can save and open it.
    - Do NOT build a new diagram from scratch. Do NOT generate matplotlib, code-generated plots, or any output that is not based on the provided template. Editing and returning the provided HTML template is the correct output.
    - Also replace the `PROBLEM STATEMENT` placeholder at the top of the template with the locked problem statement from step 1. Verify that no template placeholder or default text remains before returning the file.
    - Classify every factor as **CONFIRMED**, **UNVERIFIED**, or **DISPROVEN** using the rules in the Evidence classification section below. In particular: only facts stated verbatim or by direct paraphrase in the user's input may be CONFIRMED. If a claim is built on the absence of information — for example, inferring a missing control because no one mentioned it — it must be UNVERIFIED, not CONFIRMED.
    - Render every factor with its status tag using this exact markup: `<span class="tag tag-{status-lowercase}">{STATUS}</span> {factor text}`. For example: `<span class="tag tag-confirmed">CONFIRMED</span> Config file was missing at deploy time.` The visible label must be uppercase `CONFIRMED`, `UNVERIFIED`, or `DISPROVEN`, but the class suffix must be lowercase `confirmed`, `unverified`, or `disproven` to match the template CSS.
    - Escape all user-derived text before inserting it into the HTML. Replace `&` with `&amp;`, `<` with `&lt;`, `>` with `&gt;`, `"` with `&quot;`, and `'` with `&#039;`. The only raw markup allowed in the output is the fixed status `<span>` described above; all problem-statement and factor text must be HTML-escaped.

 5. **Separate root cause from contributing factors**
    - Root cause: the fundamental origin that, if eliminated, prevents recurrence.
    - Contributing factor: made the problem more likely or more severe, but is not the origin.
    - Present both clearly; fixing only contributing factors will not fully resolve the issue.

 6. **Output the diagnosis**
    - Root cause: one precise sentence.
    - Evidence: the "why" chain or diagram nodes that support it.
    - Contributing factors: bullet list with severity or likelihood.
    - Recommended actions: ordered by whether they address the root cause or only contributing factors.

## Evidence classification

Classify every factor in the fishbone as **CONFIRMED**, **UNVERIFIED**, or **DISPROVEN**.

- **CONFIRMED** — the fact is stated verbatim in the user's input, or is a direct paraphrase with no added detail.
- **UNVERIFIED** — the fact is an inference, an assumption, or any detail not explicitly provided by the user. This also includes claims built on the absence of information (for example, inferring a missing control from the fact that no one mentioned it).
- **DISPROVEN** — the user's input directly contradicts the claim.

**Rule:** Only facts present verbatim or by direct paraphrase in the user's input may be tagged CONFIRMED. Every added detail, inference, or absence of a piece of information that leads you to think the opposite is true, must be UNVERIFIED.

**Positive example (CONFIRMED):**
- User says: "The deploy failed because the config file was missing."
- Factor: "Config file was missing at deploy time." → **CONFIRMED** (verbatim)

**Negative example (UNVERIFIED):**
- User says: "The deploy failed and no one remembered checking the config."
- Factor: "The team did not have a checklist for config validation." → **UNVERIFIED** (inference from absence of information — the user never said a checklist existed or was missing)

## Guardrails

- Never skip the "why" chain. Symptoms are not causes.
- Do not propose fixes before the root cause is stated.
- Separate factual evidence from assumptions; label anything unverified.
- If evidence is missing, say so explicitly rather than inferring.
- Do not assign blame. Describe mechanisms and conditions, not people.
- Stop at actionable causes. Do not drift into speculation or philosophy.
