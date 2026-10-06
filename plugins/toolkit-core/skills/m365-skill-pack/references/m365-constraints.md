# Microsoft 365 Copilot custom skill constraints

Documented limits that `scripts/pack-skill.mjs` enforces. Verified against
learn.microsoft.com on **2026-10-06**. The feature is in preview; re-check the sources
when a package that used to upload is rejected.

Sources:

- [Custom skills in declarative agents (preview)](https://learn.microsoft.com/microsoft-365/copilot/extensibility/declarative-agent-skills)
- [Add custom skills to your declarative agent in Agent Builder (preview)](https://learn.microsoft.com/microsoft-365/copilot/extensibility/agent-builder-add-skills)
- [Manage and delete skills in an agent](https://learn.microsoft.com/microsoft-copilot-studio/agents-experience/skills-manage) (load-time failure table)

## Availability

- Preview, limited to organisations enrolled in the Microsoft Frontier Program.
- Requires a Microsoft 365 Copilot license or pay-as-you-go access.
- Not available in tenants that use Microsoft Purview Information Barriers.
- Skills cannot yet be reused across agents; upload the same zip to each agent.
- **An agent cannot have both skills and embedded (knowledge) files.** Repository
  context therefore travels in the input bundle, never as agent knowledge.

## Package

| Item | Agent Builder |
| --- | --- |
| Upload unit | a complete `.zip`; `SKILL.md` alone is rejected |
| `SKILL.md` | required at the package root; YAML frontmatter with `name` and `description`; instructions under 20,000 characters; UTF-8 without BOM |
| Skills per agent | 8 |
| Zip size | 50 MB |
| File size | 25 MB each |
| Files | 350 across all skills of one agent |
| Directory depth | 3 (the packer defaults to two nested directories because the docs do not define the origin; `--max-depth 3` relaxes) |

## Allowed file types

Resources: `.json .xml .yaml .yml .ini .config .utf8 .docx .doc .docm .pdf .txt .rtf
.md .ppt .pptx .ppsm .xlsx .xls .xlsm .csv .tsv .html .htm .png .jpg .jpeg .gif .bmp
.log`

Scripts and binaries: `.py .js .mjs .cjs .ts .mts .sh .bash`

Anything else is rejected by the packer. In particular **`.cmd`, `.bat`, `.ps1` and
`.exe` cannot be shipped**; write sandbox-side logic in Python or shell.

## Script sandbox

| Capability | Support |
| --- | --- |
| Internet or network access from scripts | none |
| Package installation | none |
| Pre-installed packages | only what the sandbox already has; do not depend on any until the probe skill has confirmed it |
| Connectors, API plugins, MCP servers from scripts | none (the orchestrator can use them, scripts cannot) |
| Sensitivity labels | preserved and enforced |
| Storage of uploaded skill files | tenant-scoped SharePoint Embedded container |

## Agent instructions

8,000 characters (checked by `pack-skill.mjs instructions`). See
`agent-builder-rules.md` for the other Agent Builder fields.

## Measured

Facts established by running the probe and hello tasks in a real tenant. Add a dated line per
fact; leave the documented sections above untouched.

| Date | Fact | Evidence |
| --- | --- | --- |
| (none yet) | | |

Open questions to settle on the first run:

- Is a deflate-compressed zip accepted, or only store (`--store`)?
- Is `SKILL.md` at the zip root accepted, or must entries sit under a folder (`--wrap`)?
- Can a script read a `.zip` attached to the chat from disk, and under which path?
- Is a `.md` attachment delivered to the sandbox intact, or should `--ext txt` be used?
- Does the "create documents, charts and code" toggle have to be on for scripts to run?
- Where do created files land in OneDrive?
- Which Python version and which third-party modules exist?
