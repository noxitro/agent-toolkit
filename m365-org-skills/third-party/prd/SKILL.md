---
name: prd
description: 'Generate high-quality Product Requirements Documents (PRDs) for software systems and AI-powered features. Includes executive summaries, user stories, technical specifications, and risk analysis. 日本語での依頼例: 「PRD を書いて」「新機能の要求をまとめて」「プロダクト要求仕様書」。技術仕様書・設計書には使わない(create-specification を使う)。'
license: MIT
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
- 原文どおり、書き始める前に必ず 2 つ以上質問する(エージェントの指示に「質問は 1 回にまとめる」とあっても、このスキルでは原文を優先する)。
- 原文の例(Vercel/Next.js、Lighthouse など)は例示。採用技術は聞くか、要確認(TBD)にする。
- ファイル名は `prd_<機能名>.md`。

## 原文

# Product Requirements Document (PRD)

## Overview

Design comprehensive, production-grade Product Requirements Documents (PRDs) that bridge the gap between business vision and technical execution. This skill works for modern software systems, ensuring that requirements are clearly defined.

## When to Use

Use this skill when:

- Starting a new product or feature development cycle
- Translating a vague idea into a concrete technical specification
- Defining requirements for AI-powered features
- Stakeholders need a unified "source of truth" for project scope
- User asks to "write a PRD", "document requirements", or "plan a feature"

---

## Operational Workflow

### Phase 1: Discovery (The Interview)

Before writing a single line of the PRD, you **MUST** interrogate the user to fill knowledge gaps. Do not assume context.

**Ask about:**

- **The Core Problem**: Why are we building this now?
- **Success Metrics**: How do we know it worked?
- **Constraints**: Budget, tech stack, or deadline?

### Phase 2: Analysis & Scoping

Synthesize the user's input. Identify dependencies and hidden complexities.

- Map out the **User Flow**.
- Define **Non-Goals** to protect the timeline.

### Phase 3: Technical Drafting

Generate the document using the **Strict PRD Schema** below.

---

## PRD Quality Standards

### Requirements Quality

Use concrete, measurable criteria. Avoid "fast", "easy", or "intuitive".

```diff
# Vague (BAD)
- The search should be fast and return relevant results.
- The UI must look modern and be easy to use.

# Concrete (GOOD)
+ The search must return results within 200ms for a 10k record dataset.
+ The search algorithm must achieve >= 85% Precision@10 in benchmark evals.
+ The UI must follow the 'Vercel/Next.js' design system and achieve 100% Lighthouse Accessibility score.
```

---

## Strict PRD Schema

You **MUST** follow this exact structure for the output:

### 1. Executive Summary

- **Problem Statement**: 1-2 sentences on the pain point.
- **Proposed Solution**: 1-2 sentences on the fix.
- **Success Criteria**: 3-5 measurable KPIs.

### 2. User Experience & Functionality

- **User Personas**: Who is this for?
- **User Stories**: `As a [user], I want to [action] so that [benefit].`
- **Acceptance Criteria**: Bulleted list of "Done" definitions for each story.
- **Non-Goals**: What are we NOT building?

### 3. AI System Requirements (If Applicable)

- **Tool Requirements**: What tools and APIs are needed?
- **Evaluation Strategy**: How to measure output quality and accuracy.

### 4. Technical Specifications

- **Architecture Overview**: Data flow and component interaction.
- **Integration Points**: APIs, DBs, and Auth.
- **Security & Privacy**: Data handling and compliance.

### 5. Risks & Roadmap

- **Phased Rollout**: MVP -> v1.1 -> v2.0.
- **Technical Risks**: Latency, cost, or dependency failures.

---

## Implementation Guidelines

### DO (Always)

- **Define Testing**: For AI systems, specify how to test and validate output quality.
- **Iterate**: Present a draft and ask for feedback on specific sections.

### DON'T (Avoid)

- **Skip Discovery**: Never write a PRD without asking at least 2 clarifying questions first.
- **Hallucinate Constraints**: If the user didn't specify a tech stack, ask or label it as `TBD`.

---

## Example: Intelligent Search System

### 1. Executive Summary

**Problem**: Users struggle to find specific documentation snippets in massive repositories.
**Solution**: An intelligent search system that provides direct answers with source citations.
**Success**:

- Reduce search time by 50%.
- Citation accuracy >= 95%.

### 2. User Stories

- **Story**: As a developer, I want to ask natural language questions so I don't have to guess keywords.
- **AC**:
  - Supports multi-turn clarification.
  - Returns code blocks with "Copy" button.

### 3. AI System Architecture

- **Tools Required**: `codesearch`, `grep`, `webfetch`.

### 4. Evaluation

- **Benchmark**: Test with 50 common developer questions.
- **Pass Rate**: 90% must match expected citations.
