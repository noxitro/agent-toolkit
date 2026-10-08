---
name: m365-skill-pack
description: Use when a coding task should be delegated to Microsoft 365 Copilot custom agents (Agent Builder) instead of being done here - packaging skill .zip files for Agent Builder, writing _m365/TASK.md, building the input bundle of a repository, or ingesting the output bundle that comes back from the impl-loop or auditor agent. Also use when asked to validate a Microsoft 365 skill package or an agent instruction block against the documented limits.
targets: [claude, copilot]
---

# Delegating implement-audit loops to Microsoft 365 Copilot

This skill moves the expensive part of a coding task - implementing, auditing, fixing,
repeating - into two Microsoft 365 Copilot custom agents (`impl-loop` and `auditor`)
that the user created once in their Microsoft 365 tenant from the sheets in `m365/agents/`. Locally you only
write the task contract, build one input bundle without reading the repository, and
ingest the one output bundle that comes back. Nothing here calls Microsoft 365 Copilot:
there is no API or CLI for it, so the user uploads, runs and downloads by hand.

## Where the bundle may go

Only to **Microsoft 365 Copilot signed in with a work or school account**, where
Enterprise Data Protection applies and the agents created from `m365/agents/` exist. The
free consumer Copilot (the Windows Store app or copilot.microsoft.com with a personal
account) has no Enterprise Data Protection: sending a repository bundle there is a data
leak, not a test. If the user has only the free app on the current machine, build the
bundle and stop; the user carries it to the Microsoft 365 tenant. Say this plainly
whenever the user proposes attaching a bundle to anything other than that tenant.

## What exists already

- `m365/SETUP.md` - the one-time setup the user performs in Agent Builder (Japanese).
- `m365/agents/impl-loop.md`, `m365/agents/auditor.md` - paste-ready agent definition
  sheets (name, description, instructions, starter prompts, skills to attach).
- `m365/agents/impl-session.md`, `m365/agents/review-session.md` - the two agents of the
  script-driven "External loop" in `references/loop-protocol.md` (session A implements,
  session B reviews, a local script routes each reply by its `M365-STATUS:` first line).
  The controller is `scripts/lib/external-loop.mjs` (`runLoop`, independent of how turns
  are carried); the driver that operates the chat UI is not part of this skill, so the
  per-task steps below use `impl-loop` and `auditor`.
- `m365/skills/{implement,audit,probe}/` - the skill sources, packaged with
  `scripts/pack-skill.mjs --from-template`. They are project-independent; project
  conventions travel inside each input bundle. `<skill-dir>` below is wherever this
  skill is installed (the directory holding this SKILL.md).
- `references/` - the documented limits (`m365-constraints.md`,
  `agent-builder-rules.md`), the bundle format and the loop protocol. Treat the
  "Measured" tables there as the current truth about the sandbox; if they are empty,
  the probe has not been run yet and every sandbox assumption is unverified.

## First time only

Build the three zips and hand the user `m365/SETUP.md`:

```bash
node <skill-dir>/scripts/pack-skill.mjs <skill-dir>/m365/skills/implement <skill-dir>/m365/skills/audit <skill-dir>/m365/skills/probe --from-template --out <repo>/.m365/zips
```

Then stop. Creating the agents, uploading the zips and running the probe are manual
steps in Microsoft 365 Copilot. Ask the user to bring back `probe-output.txt` and record what it shows in
the "Measured" tables before relying on the sandbox for real work.

## Per task

1. **Write the task contract** at `<repo>/.m365/<slug>/TASK.md` following
   `references/loop-protocol.md`: goal, scope globs, acceptance criteria `AC-n`,
   constraints, forbidden patterns, max rounds. An acceptance criterion the auditor
   cannot verify from the files alone (no network, no installs) is a bad criterion;
   rewrite it until it is. Suggest adding `.m365/` to `.gitignore`.
2. **Build the input bundle without reading the repository**:

   ```bash
   node <skill-dir>/scripts/make-input.mjs --task <repo>/.m365/<slug>/TASK.md --repo <repo>
   ```

   It packs every tracked and untracked-but-not-ignored file (minus `.git`,
   `node_modules`, build output, `.env*` and keys) plus `CLAUDE.md` / `AGENTS.md` /
   `.github/copilot-instructions.md` as `_m365/CONVENTIONS/`, into
   `<repo>/.m365/<slug>/in-<slug>.zip`. Pass paths to restrict it, `--format md` when
   the Measured table says zip attachments are not readable in the sandbox, and set
   `M365_DROP_DIR` to also copy it into a synced OneDrive folder.
3. **Hand off and stop.** Tell the user: attach the bundle to `impl-loop`, send its
   "Run the loop" starter prompt, download `out-<slug>-r<N>.zip` from the created-file
   card or OneDrive, optionally attach that to `auditor` for an independent verdict.
   Do not poll, wait, or pretend to run the loop yourself.
4. **Ingest** when the user brings the output back:

   ```bash
   node <skill-dir>/scripts/unpack-output.mjs <out.zip> --repo <repo>
   ```

   It applies the bundle to the working tree three-way against the snapshot the sandbox
   started from: files the sandbox left untouched keep their local copy (`kept`), a
   file changed on both sides is a `conflict` and is not written (rerun with `--force`
   to take the sandbox version). A bundle without `_m365/manifest.json` is a plain
   overwrite. `_m365/*` goes to `<repo>/.m365/<slug>/reports/`. Exit codes: 3 when
   conflicts were left unresolved (this outranks the verdict), otherwise 0 PASS, 2 FAIL,
   1 no usable `AUDIT.md`. Nothing
   is committed. Review with `git diff` and the report; on FAIL decide with the user
   between fixing locally and sending another round with an updated task contract.

## Editing the agents or skills

- Agent instructions have an 8,000-character limit and must not be offloaded into
  knowledge sources. After editing a sheet, run
  `node <skill-dir>/scripts/pack-skill.mjs instructions m365/agents/<sheet>.md` (it
  measures the fenced block under `### Instructions`) and ask the user to paste the new
  block into Agent Builder.
- Skill scripts run in a sandbox with no network, no package installs and an unknown
  Python version: standard library, Python 3.8 syntax, and only `.py .js .mjs .cjs .ts
  .mts .sh .bash` for scripts - never `.cmd`, `.bat` or `.ps1`. `pack-skill.mjs`
  rejects the rest; if it reports a problem, fix the source rather than overriding.
- Keep the three implementations of the bundle format in agreement
  (`scripts/lib/bundle.mjs`, `scripts/unpack-output.mjs`,
  `m365/skills/common/scripts/bundle_io.py`); change `references/bundle-format.md`
  first.

## Traps

- Never attach a bundle to the free consumer Copilot; only a Microsoft 365 tenant with
  Enterprise Data Protection is in scope (see "Where the bundle may go").
- Agents with skills cannot have knowledge files, and typed OneDrive paths are not
  resolved: everything the agent needs goes into the bundle, attached directly.
- Do not read the repository to "help" the bundle; the point of the delegation is that
  this session spends tokens only on the task contract and the verdict.
- The sandbox cannot run git. Deletions come back as `_m365/DELETED.txt`, renames as
  delete plus add.
- A PASS from `impl-loop` is self-review. For anything that matters, run `auditor` too
  and compare the two verdicts; a disagreement is the finding. Ingesting the audit bundle
  after the output bundle saves it as `reports/AUDIT.auditor.md` next to the
  implementer's `AUDIT.md`.
- Machine-specific paths do not belong in task contracts or bundles; the sandbox never
  sees your disk.
