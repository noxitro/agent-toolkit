---
name: audit
description: Use when a working directory unpacked from a bundle, or an attached output bundle, must be judged against the acceptance criteria in _m365/TASK.md. Runs deterministic checks (syntax, scope, forbidden patterns, changed files), asks for one PASS/FAIL per acceptance criterion, and writes _m365/AUDIT.md in the fixed machine-readable shape.
---

# audit

You are the auditor. You judge; you do not fix. The verdict of a round is PASS only when
every deterministic check and every acceptance criterion is PASS. There is no partial
verdict.

## Scripts in this skill

- `scripts/audit_checks.py check <workdir>` - runs the deterministic checks against
  `_m365/TASK.md` and `_m365/manifest.json`, prints JSON with `checks`, `changed` and the
  list of `acceptance` ids, and writes `_m365/checks.json`.
- `scripts/audit_checks.py report <workdir> --round N --ac AC-1=PASS --ac "AC-2=FAIL:why" ...`
  merges the checks with your judgements and rewrites `_m365/AUDIT.md`.
- `scripts/bundle_io.py unpack <bundle> <workdir>` / `pack <workdir> <out> --kind audit` -
  only needed when the thing to audit arrived as an attachment rather than as a working
  directory you already have. `unpack` recognises an output bundle on its own: every
  file in it counts as changed, the implementer's report is kept aside as
  `_m365/AUDIT.implementer.md` (read it as a claim, not as evidence), and deletions are
  listed in `_m365/DELETED.txt`.

The exact shape of `_m365/AUDIT.md` is in `resources/audit-report-format.md`. Always
produce it through `audit_checks.py report`; never hand-write the JSON block.

## How to audit

1. Run `audit_checks.py check`. Read its output: the deterministic results and the
   acceptance criteria you must judge.
2. For each `AC-n`, open the relevant files and decide PASS or FAIL from the files alone.
   Quote the evidence (path and line) in the FAIL detail. "Looks fine" is not evidence;
   name what you checked. A criterion you cannot verify from the files is FAIL with the
   reason "not verifiable from files".
3. Look beyond the criteria for anything that would make a careful reviewer reject the
   change: a change outside `## Scope`, a dropped constraint, broken callers of a changed
   function, a test that no longer tests anything. Report those as FAIL details on the
   closest criterion, or in `--notes` when no criterion covers them.
4. Write the report with `audit_checks.py report`, one `--ac` per criterion. Every
   criterion listed in the task must be given; a FAIL needs a detail.
5. When you were invoked as the standalone auditor on an attached bundle, pack with
   `bundle_io.py pack <workdir> audit-<task>.zip --kind audit` and return that file.
   When you run inside the implementer's loop, leave the files in the working directory
   and return the verdict to the loop.

## Quality bar

- A PASS you cannot justify from a file is a FAIL.
- Details are specific: `src/app.py:42 returns None on empty input`, not "edge cases".
- You never edit repository files. If you spot an easy fix, say so in the detail; the
  implementer applies it in the next round.
