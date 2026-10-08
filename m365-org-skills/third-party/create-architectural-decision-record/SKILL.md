---
name: create-architectural-decision-record
description: 'Create an Architectural Decision Record (ADR) document for AI-optimized decision documentation. 日本語での依頼例: 「ADR を書いて」「設計判断を記録して」「アーキテクチャの決定記録」。'
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
- 連番 `NNNN` はユーザーに確認する。分からなければ `adr-XXXX-<題名>.md` とし、番号は要確認と書く。
- 日付はユーザーが示したもの。示されていなければ要確認。
- 却下の理由・良い影響・悪い影響は、ユーザーの説明や資料にあるものだけを書く。無ければ「要確認」とし、作らない。

## 原文

# Create Architectural Decision Record

Create an ADR document for `${input:DecisionTitle}` using structured formatting optimized for AI consumption and human readability.

## Inputs

- **Context**: `${input:Context}`
- **Decision**: `${input:Decision}`
- **Alternatives**: `${input:Alternatives}`
- **Stakeholders**: `${input:Stakeholders}`

## Input Validation
If any of the required inputs are not provided or cannot be determined from the conversation history, ask the user to provide the missing information before proceeding with ADR generation.

## Requirements

- Use precise, unambiguous language
- Follow standardized ADR format with front matter
- Include both positive and negative consequences
- Document alternatives with rejection rationale
- Structure for machine parsing and human reference
- Use coded bullet points (3-4 letter codes + 3-digit numbers) for multi-item sections

The ADR must be saved in the `/docs/adr/` directory using the naming convention: `adr-NNNN-[title-slug].md`, where NNNN is the next sequential 4-digit number (e.g., `adr-0001-database-selection.md`).

## Required Documentation Structure

The documentation file must follow the template below, ensuring that all sections are filled out appropriately. The front matter for the markdown should be structured correctly as per the example following:

```md
---
title: "ADR-NNNN: [Decision Title]"
status: "Proposed"
date: "YYYY-MM-DD"
authors: "[Stakeholder Names/Roles]"
tags: ["architecture", "decision"]
supersedes: ""
superseded_by: ""
---

# ADR-NNNN: [Decision Title]

## Status

**Proposed** | Accepted | Rejected | Superseded | Deprecated

## Context

[Problem statement, technical constraints, business requirements, and environmental factors requiring this decision.]

## Decision

[Chosen solution with clear rationale for selection.]

## Consequences

### Positive

- **POS-001**: [Beneficial outcomes and advantages]
- **POS-002**: [Performance, maintainability, scalability improvements]
- **POS-003**: [Alignment with architectural principles]

### Negative

- **NEG-001**: [Trade-offs, limitations, drawbacks]
- **NEG-002**: [Technical debt or complexity introduced]
- **NEG-003**: [Risks and future challenges]

## Alternatives Considered

### [Alternative 1 Name]

- **ALT-001**: **Description**: [Brief technical description]
- **ALT-002**: **Rejection Reason**: [Why this option was not selected]

### [Alternative 2 Name]

- **ALT-003**: **Description**: [Brief technical description]
- **ALT-004**: **Rejection Reason**: [Why this option was not selected]

## Implementation Notes

- **IMP-001**: [Key implementation considerations]
- **IMP-002**: [Migration or rollout strategy if applicable]
- **IMP-003**: [Monitoring and success criteria]

## References

- **REF-001**: [Related ADRs]
- **REF-002**: [External documentation]
- **REF-003**: [Standards or frameworks referenced]
```
