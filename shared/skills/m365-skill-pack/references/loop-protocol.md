# Loop protocol

The implement-audit loop runs inside Microsoft 365 Copilot. Nothing local drives it:
the `impl-loop` agent's instructions carry the loop, a person starts it with one
message, and the only things that cross the boundary are the input bundle (in) and the
output bundle (out). This file is the contract both sides follow.

## Roles

| Agent | Skills attached | Reads | Writes |
| --- | --- | --- | --- |
| `impl-loop` | `implement`, `audit` | input bundle | one output bundle after the last round |
| `auditor` | `audit` | an output bundle | one audit bundle holding only `_m365/AUDIT.md` |

`auditor` never changes code. It exists because a reviewer that did not write the code
finds what self-review misses.

## `_m365/TASK.md` (written locally, before the input bundle is made)

```markdown
# TASK <slug>

## Goal

One paragraph. What must be true when the task is done.

## Scope

- src/app/**
- tests/test_app.py

## Acceptance

- AC-1: every changed .py file compiles (py_compile).
- AC-2: src/app/validator.py rejects an empty name and tests/test_app.py covers it.

## Constraints

- Do not add dependencies.

## Forbidden patterns

- print\(

## Max rounds

3
```

- `Scope` lists glob patterns the implementer may change; anything outside is a FAIL in
  the audit. `*` and `?` do not cross `/`, `**` does (`src/**` is the whole subtree,
  `src/*.py` only the top level), a trailing `/` means the whole directory, and `[...]`
  character classes work. This is `audit_checks.py`'s own matcher, not Python's fnmatch.
- Each `AC-n` must be checkable from the files alone: no network, no package
  installation, no external service. An acceptance criterion the auditor cannot verify
  from files is a bad criterion; rewrite it.
- `Forbidden patterns` are regular expressions applied to changed text files.
- `Max rounds` defaults to 3 when absent.

## Rounds

- Rounds are numbered from 1. The input bundle is round 0.
- Round 1 implements. Round N >= 2 fixes what the previous audit flagged.
- After every round the agent runs the audit skill (deterministic checks via
  `audit_checks.py`, then one judgement per AC) and records the verdict.
- The loop continues only while the verdict is FAIL and the round is below
  `Max rounds`. It stops on PASS or when the rounds are exhausted.
- The output bundle is produced **once**, after the last round, with `pack --full` so it
  carries the whole working tree and the input manifest. The agent does not ask the user
  anything in between.

## Verdict

PASS if and only if every deterministic check passes and every AC is PASS. Any single
FAIL makes the round FAIL. There is no partial verdict.

## `_m365/AUDIT.md`

The first line is `# AUDIT`. The first fenced `json` block after it is the
machine-readable summary; everything after that block is prose for humans.

````markdown
# AUDIT

```json
{
  "schema": "m365-audit/1",
  "task": "<slug>",
  "verdict": "PASS",
  "final_round": 2,
  "max_rounds": 3,
  "rounds": [
    {
      "round": 1,
      "verdict": "FAIL",
      "checks": [
        { "id": "syntax", "status": "PASS" },
        { "id": "scope", "status": "PASS" },
        { "id": "forbidden", "status": "FAIL", "detail": "src/app.py:12: print\\(" },
        { "id": "AC-1", "status": "PASS" },
        { "id": "AC-2", "status": "FAIL", "detail": "no test covers the empty name" }
      ]
    },
    {
      "round": 2,
      "verdict": "PASS",
      "checks": [
        { "id": "syntax", "status": "PASS" },
        { "id": "scope", "status": "PASS" },
        { "id": "forbidden", "status": "PASS" },
        { "id": "AC-1", "status": "PASS" },
        { "id": "AC-2", "status": "PASS" }
      ]
    }
  ]
}
```

## Round 1

...
````

Check ids `syntax`, `json`, `scope`, `forbidden` and `files` come from
`audit_checks.py`; `AC-n` come from the model's judgement against `_m365/TASK.md`.
`status` is `PASS` or `FAIL`; `detail` is required on FAIL.

`unpack-output.mjs` parses only the JSON block and exits 3 when files changed both
locally and in the sandbox were left unwritten (see `--force`; this outranks the
verdict), otherwise 0 on PASS, 2 on FAIL, 1 when the block is missing or malformed.

## `_m365/ROUNDS.md`

Human-readable only. One `## Round N` section per round listing the files changed,
the check results and what was fixed. Not parsed.

## Output bundle naming

- `impl-loop`: `out-<slug>-r<N>.zip` where N is the final round.
- `auditor`: `audit-<slug>.zip` containing only `_m365/AUDIT.md` with a single round.

## Fixed prompts

Starter prompt for `impl-loop` (also registered as a suggested prompt in Agent Builder):

```text
Unpack the attached input bundle with the implement skill, run the implement-audit
loop as your instructions describe, and return exactly one output bundle.
```

Starter prompt for `auditor`:

```text
Unpack the attached output bundle with the audit skill, audit it against the task file
inside it, and return exactly one audit bundle containing only the AUDIT.md report.
```
