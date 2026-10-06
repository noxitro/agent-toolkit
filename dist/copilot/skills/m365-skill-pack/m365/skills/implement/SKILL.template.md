---
name: implement
description: Use when an input bundle (a .zip or a Markdown file whose first line is "# m365-bundle v1") is attached and the task is to implement or fix code according to the _m365/TASK.md inside it. Unpacks the bundle, applies changes in a working directory, keeps a round log, and repacks only what changed into one output bundle.
---

# implement

You are the implementer of a task that arrived as one attached bundle. Everything you
need is inside it: the repository files, `_m365/TASK.md` (goal, scope, acceptance
criteria, constraints, forbidden patterns, max rounds) and, when present,
`_m365/CONVENTIONS/*` (the project's coding conventions - follow them).

## Scripts in this skill

All scripts are Python 3, standard library only, and run in the sandbox.

- `scripts/bundle_io.py unpack <bundle> <workdir>` - extract the bundle and write
  `_m365/manifest.json` (hashes of the original files).
- `scripts/bundle_io.py status <workdir>` - added / modified / deleted since unpack.
- `scripts/bundle_io.py pack <workdir> <out.zip>` - write the output bundle holding only
  changed files, deletions and the `_m365/` protocol files.
- `scripts/run_round.py start <workdir>` - begin a round (refuses past max rounds).
- `scripts/run_round.py finish <workdir> --verdict PASS|FAIL [--notes ...]` - record the
  round in `_m365/ROUNDS.md` and say whether to continue.

Read `resources/bundle-format.md` if you need the exact file format.

## How to work

1. Unpack the attachment into a fresh working directory. Read `_m365/TASK.md` fully and
   `_m365/CONVENTIONS/*` if present. Do not ask the user questions; the task file is the
   whole specification. If something is impossible, say so in the round notes and in the
   final answer, and still return a bundle.
2. Start a round with `run_round.py start`.
3. Change only files that match a `## Scope` pattern. Keep every `## Constraints` line.
   Never introduce text matching a `## Forbidden patterns` entry. Prefer small, complete
   changes over broad rewrites. Do not rename or reformat files you were not asked to
   touch.
4. Make every `AC-n` in `## Acceptance` true. Each one must be verifiable from the files
   alone, so leave the evidence in the files (tests, docstrings, data) rather than in
   prose.
5. When the round's work is done, hand over to the audit skill if it is available to you
   (the agent instructions say whether it is). Record the verdict with
   `run_round.py finish`. On `"next": "continue"`, start the next round and fix exactly
   what the audit flagged. On `"next": "stop"`, pack.
6. Pack once, after the last round: `bundle_io.py pack <workdir> out-<task>-r<N>.zip`
   where N is the final round. Return that file to the user. Do not return partial
   bundles between rounds.

## Quality bar

- The output bundle contains only what changed, plus `_m365/ROUNDS.md` and, when the
  audit skill ran, `_m365/AUDIT.md`.
- Round notes say what was changed and why, in a few lines. No pasted diffs.
- A change outside scope, a dropped constraint, or a forbidden pattern is a failure even
  when the acceptance criteria pass.
