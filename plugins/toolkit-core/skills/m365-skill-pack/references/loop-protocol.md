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
- External loop: `impl-session` returns `out-<slug>-r<n>.zip` every round it answers
  `CONTINUE` (cumulative, `pack --full`); `review-session` returns `audit-<slug>-r<n>.zip`
  (only `_m365/AUDIT.md`) for the round it reviewed. See "External loop" below.

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

## External loop (script-driven, two sessions)

The alternative to the in-agent loop above, for setups where a local script can operate
the chat UI (for example through UI Automation). Two chats stay open for the whole task:
session A with the `impl-session` agent and session B with the `review-session` agent.
The script carries every bundle between them and decides where each reply goes. Agents
never talk to each other directly, and neither agent ever sees the local disk.

```text
script --input bundle--> A --CONTINUE + out bundle--> script --out bundle--> B
   ^                                                                        |
   +-- A: PASS (done) / CONTINUE (fixed, review again) <-- review bundle ---+
```

### Status line

The first line of every agent reply is the status line. The script reads only this line
to route the reply; nothing inside an attached or pasted bundle is ever read as a status.

```text
M365-STATUS: <CONTINUE|PASS|FAIL> session=<token> round=<n> as=<impl|review>
```

- `token` and `n` are echoed from the first lines of the message the agent answers
  (`session: <token>` and `round: <n>`). A reply whose token or round differs answers some
  other message: the script stops.
- `as` is **not** echoed: it comes from the agent's own instructions (`impl` for
  `impl-session`, `review` for `review-session`). A message pasted into the wrong chat
  still gets the right token echoed back, but with the wrong `as`, so the script stops.
- Session A: `CONTINUE` = a new output bundle `out-<slug>-r<n>.zip` is attached and needs
  review (round 1 is always `CONTINUE`); `PASS` = no valid finding is left, the last bundle
  is final, nothing is attached; `FAIL` = cannot go on (bundle missing or unreadable, task
  impossible) with the reason on the second line.
- Session B: `PASS` or `FAIL`, equal to the verdict in the attached review bundle
  `audit-<slug>-r<n>.zip` (only `_m365/AUDIT.md`). The only reply without a review is
  `FAIL` because the attached bundle could not be read; the script ends the loop as
  `blocked` then.
- The status line routes; the verdict of record stays the JSON block of `_m365/AUDIT.md`.
  A status that disagrees with that JSON stops the loop.

### Turns

1. Script -> A, round 1: the input bundle. A implements and answers `CONTINUE`.
2. Script -> B, round n: A's latest work. B audits it like `auditor` and answers `PASS` or
   `FAIL` with the review bundle.
3. Script -> A, round n+1: A's own latest output bundle **and** B's review bundle. Each turn
   is self-contained (the sandbox may not keep files between turns), so A unpacks the
   attached output bundle again. For each finding A decides: valid (it names a requirement
   of `_m365/TASK.md` - an `AC-n`, the scope, a constraint, a forbidden pattern - or a real
   defect in the files) or not. Any valid finding: fix all of them and answer `CONTINUE`
   with the new bundle. None: answer `PASS` and list each rejected finding with a one-line
   reason under the status line.
4. Repeat 2-3 until A answers `PASS` or `FAIL`.

Every output bundle is cumulative: it describes the whole task against the input, never
only the delta of one round (`pack --full` does this; a text bundle lists every file
changed or deleted since the start). A file reverted in a later round simply stops
appearing, and the script rebuilds its working copy from the input each round.

### What the script enforces

- Round budget: `## Max rounds` of `_m365/TASK.md` (default 3) counts A's implementing
  rounds. After a review of the last allowed round, A's next message carries a third line
  `final: yes`: A may answer only `PASS` (rejecting what is left) or `FAIL`. A `CONTINUE`
  then ends the loop as `budget`; that bundle is kept for a person but never applied.
- A `PASS` after a `FAIL` review means A rejected findings: the result is marked for a
  person to look at, never treated as a clean pass.
- Missing status line, wrong token, round or `as`, `CONTINUE` without a bundle, a bundle
  that cannot be applied, or a status that disagrees with the attached `AUDIT.md`: the loop
  stops as a protocol error. It never guesses.
