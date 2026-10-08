---
name: create-specification
description: 'Create a new specification file for the solution, optimized for Generative AI consumption. 日本語での依頼例: 「仕様書を作って」「設計書のたたき台」「要件と受け入れ条件を整理して」。新機能の企画段階の要求(PRD)には使わない(prd を使う)。'
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
- 原文の「テスト自動化方針」にある MSTest などの .NET の例は例示。ユーザーの技術スタックが分からなければ要確認と書く。
- ファイル名は原文どおり `spec-<目的>-<名前>.md`。

## 原文

# Create Specification

Your goal is to create a new specification file for `${input:SpecPurpose}`.

The specification file must define the requirements, constraints, and interfaces for the solution components in a manner that is clear, unambiguous, and structured for effective use by Generative AIs. Follow established documentation standards and ensure the content is machine-readable and self-contained.

## Best Practices for AI-Ready Specifications

- Use precise, explicit, and unambiguous language.
- Clearly distinguish between requirements, constraints, and recommendations.
- Use structured formatting (headings, lists, tables) for easy parsing.
- Avoid idioms, metaphors, or context-dependent references.
- Define all acronyms and domain-specific terms.
- Include examples and edge cases where applicable.
- Ensure the document is self-contained and does not rely on external context.

The specification should be saved in the `/spec/` directory and named according to the following convention: `spec-[a-z0-9-]+.md`, where the name should be descriptive of the specification's content and starting with the highlevel purpose, which is one of [schema, tool, data, infrastructure, process, architecture, or design].

The specification file must be formatted in well formed Markdown.

Specification files must follow the template below, ensuring that all sections are filled out appropriately. The front matter for the markdown should be structured correctly as per the example following:

```md
---
title: [Concise Title Describing the Specification's Focus]
version: [Optional: e.g., 1.0, Date]
date_created: [YYYY-MM-DD]
last_updated: [Optional: YYYY-MM-DD]
owner: [Optional: Team/Individual responsible for this spec]
tags: [Optional: List of relevant tags or categories, e.g., `infrastructure`, `process`, `design`, `app` etc]
---

# Introduction

[A short concise introduction to the specification and the goal it is intended to achieve.]

## 1. Purpose & Scope

[Provide a clear, concise description of the specification's purpose and the scope of its application. State the intended audience and any assumptions.]

## 2. Definitions

[List and define all acronyms, abbreviations, and domain-specific terms used in this specification.]

## 3. Requirements, Constraints & Guidelines

[Explicitly list all requirements, constraints, rules, and guidelines. Use bullet points or tables for clarity.]

- **REQ-001**: Requirement 1
- **SEC-001**: Security Requirement 1
- **[3 LETTERS]-001**: Other Requirement 1
- **CON-001**: Constraint 1
- **GUD-001**: Guideline 1
- **PAT-001**: Pattern to follow 1

## 4. Interfaces & Data Contracts

[Describe the interfaces, APIs, data contracts, or integration points. Use tables or code blocks for schemas and examples.]

## 5. Acceptance Criteria

[Define clear, testable acceptance criteria for each requirement using Given-When-Then format where appropriate.]

- **AC-001**: Given [context], When [action], Then [expected outcome]
- **AC-002**: The system shall [specific behavior] when [condition]
- **AC-003**: [Additional acceptance criteria as needed]

## 6. Test Automation Strategy

[Define the testing approach, frameworks, and automation requirements.]

- **Test Levels**: Unit, Integration, End-to-End
- **Frameworks**: MSTest, FluentAssertions, Moq (for .NET applications)
- **Test Data Management**: [approach for test data creation and cleanup]
- **CI/CD Integration**: [automated testing in GitHub Actions pipelines]
- **Coverage Requirements**: [minimum code coverage thresholds]
- **Performance Testing**: [approach for load and performance testing]

## 7. Rationale & Context

[Explain the reasoning behind the requirements, constraints, and guidelines. Provide context for design decisions.]

## 8. Dependencies & External Integrations

[Define the external systems, services, and architectural dependencies required for this specification. Focus on **what** is needed rather than **how** it's implemented. Avoid specific package or library versions unless they represent architectural constraints.]

### External Systems
- **EXT-001**: [External system name] - [Purpose and integration type]

### Third-Party Services
- **SVC-001**: [Service name] - [Required capabilities and SLA requirements]

### Infrastructure Dependencies
- **INF-001**: [Infrastructure component] - [Requirements and constraints]

### Data Dependencies
- **DAT-001**: [External data source] - [Format, frequency, and access requirements]

### Technology Platform Dependencies
- **PLT-001**: [Platform/runtime requirement] - [Version constraints and rationale]

### Compliance Dependencies
- **COM-001**: [Regulatory or compliance requirement] - [Impact on implementation]

**Note**: This section should focus on architectural and business dependencies, not specific package implementations. For example, specify "OAuth 2.0 authentication library" rather than "Microsoft.AspNetCore.Authentication.JwtBearer v6.0.1".

## 9. Examples & Edge Cases

    ```code
    // Code snippet or data example demonstrating the correct application of the guidelines, including edge cases
    ```

## 10. Validation Criteria

[List the criteria or tests that must be satisfied for compliance with this specification.]

## 11. Related Specifications / Further Reading

[Link to related spec 1]
[Link to relevant external documentation]

```
