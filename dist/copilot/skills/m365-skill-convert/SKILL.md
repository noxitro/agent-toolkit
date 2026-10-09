---
name: m365-skill-convert
description: Use when the user asks to convert, package or zip an existing agent skill (a folder with SKILL.md - a local folder, a GitHub folder URL, or an installed skill name) so it can be added to Microsoft 365 Copilot Agent Builder or Copilot Cowork. Produces the skill zip and a Japanese report of the automatic fixes and machine checks. Not for delegating coding tasks to Microsoft 365 Copilot or for the impl-loop / auditor bundles - that is m365-skill-pack.
---

<!-- Generated file - do not edit this copy; the next build overwrites it. It is generated from shared/skills/m365-skill-convert/SKILL.md in the agent-toolkit repository, which is not present alongside this file and must not be opened. -->

# Converting a skill into a Microsoft 365 Copilot skill zip

`<skill-dir>` below is the directory holding this SKILL.md. The script needs Node 20+
(and git for GitHub input). It never executes anything from the skill and never writes to
the source folder; GitHub input is fetched as a shallow, sparse, symlink-free clone into
the OS temp folder and deleted afterwards.

## 1. Run the converter

```bash
node <skill-dir>/scripts/skill2zip.mjs <folder | GitHub folder URL | installed skill name> [--out <dir>] [--name <name>]
```

It writes into `./m365-zips/` (or `--out`): `<name>.zip`, `<name>.report.md` (Japanese),
`node_modules/<name>/` (exactly what is in the zip) and, when the Japanese 読み替え
overlay is on, `<name>.overlay.json`. Exit code 0 means a zip was written, 1 that it
stopped (the report says why), 2 bad input. For an ambiguous installed name it lists every
match: ask the user which one and rerun with that path.

Defaults: GitHub input is treated as third-party (overlay on, `LICENSE.txt` and
`SOURCE.md` added to the zip); local and installed skills as the user's own (no overlay).
`--origin own|third-party` and `--overlay ja|none` change that. `--draft` writes
`<name>.draft.zip` while overlay TODOs remain - fine for a preview, never for upload.

`--force` (continue despite blockers) and `--allow-license-unknown` (own skill without a
license) are the user's decisions after reading the reasons. Do not add them on your own.

A frontmatter `name` that is not a valid skill name (lowercase letters, digits and single
hyphens, at most 64 characters) stops the conversion even with `--force`; output file
names never use it. Propose a name and rerun with `--name <name>` once the user agrees.
`--max-depth 3` relaxes the folder depth limit (default 2). Variables that nothing
replaces in Microsoft 365 (`$ARGUMENTS`, `${CLAUDE_...}`, `${input:...}`) do not stop the
conversion; they are listed first in the report - always mention them to the user.
The last stdout line is `REPORT: <path>` whenever a report was written.

## 2. Read everything, then report to the user

The machine checks are string matching; they miss things and flag false positives. So:

1. Read `<name>.report.md`.
2. Read the whole skill as packaged: `SKILL.md` and every file under
   `node_modules/<name>/` (scripts, references, assets, HTML), not only the parts the
   report mentions.
3. Tell the user, in Japanese:
   - what the skill makes the model do, in a few lines;
   - concerns: data sent anywhere (URLs, network calls, external scripts or images in
     HTML), personal data and privacy, profiling or evaluating people, license terms,
     Claude-only features that will not work in the sandbox;
   - for the overlay TODOs: a proposed `trigger_ja` (Japanese request examples, and when
     another skill should be used instead) and skill-specific `extra` lines. Write them
     into `<name>.overlay.json` only after the user agrees, then rerun the same command.

Never say the skill is safe or approved: the report is a pre-screen and the human decides.
Never upload the zip or any part of the skill anywhere; adding it in Agent Builder
(Configure > Skills > Add) is the user's manual step.
