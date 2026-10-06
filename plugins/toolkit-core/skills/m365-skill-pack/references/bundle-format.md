# Bundle format

A *bundle* is the one file that carries a repository subset into the Microsoft 365
Copilot sandbox and carries the result back. Two encodings share one path model:

- **ZIP** (default) - a plain `.zip`, entry names as described below.
- **Markdown** (`--format md`) - one UTF-8 text file, for surfaces that cannot read a
  ZIP attachment.

Three implementations must agree with this document: `scripts/lib/bundle.mjs` and
`scripts/unpack-output.mjs` (local) and `m365/skills/common/scripts/bundle_io.py`
(sandbox). Change the spec first, then all three.

## Path model (both encodings)

- Paths are relative to the repository root, use `/` as the separator, and never start
  with `./` or `/`.
- Forbidden: a `..` segment, a drive letter (`C:`), a backslash, an empty segment, a
  segment that is `.git` in any letter case or one of its 8.3 short names (`GIT~1`),
  a segment ending in a dot or space, and the characters `: < > " | ? *` or control
  characters anywhere (the same family git's `core.protectNTFS` refuses). Duplicate
  paths are also an error. An unpacker that meets one of these refuses the whole file.
- The prefix `_m365/` is reserved for protocol files and is never written into the
  repository. Known members:

| Path | Written by | Purpose |
| --- | --- | --- |
| `_m365/TASK.md` | local harness | the task contract (see `loop-protocol.md`) |
| `_m365/CONVENTIONS/<file>` | `make-input.mjs` | copies of `CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md` when present |
| `_m365/manifest.json` | `bundle_io.py unpack` | `{ "files": { "<path>": "<sha256>" } }` of the input, used to detect changes |
| `_m365/DELETED.txt` | implement skill | paths removed during the task, one per line (ZIP encoding only) |
| `_m365/state.json` | `run_round.py` | round counter and history (never packed) |
| `_m365/checks.json` | `audit_checks.py check` | the last deterministic check results |
| `_m365/AUDIT.implementer.md` | `bundle_io.py unpack` | the implementer's `AUDIT.md` set aside when an output bundle is unpacked for an independent audit |
| `_m365/ROUNDS.md` | implement skill | human-readable round log |
| `_m365/AUDIT.md` | audit skill | verdict, machine-readable JSON block first |

An unpacker routes every `_m365/` entry to the reports directory, never into the repo.

## ZIP encoding

- Entry names follow the path model. No directory entries, no absolute names.
- Method 0 (store) or 8 (deflate). No encryption, no ZIP64, no data descriptors.
- An output ZIP contains **only changed, added and protocol files**. Unchanged files are
  omitted. A deletion is expressed by listing the path in `_m365/DELETED.txt`.
- Bytes are carried as-is; the ZIP packer does not touch line endings.

## Markdown encoding

````text
# m365-bundle v1
- task: <slug>
- kind: input | output | audit
- round: <N>
- created: <ISO-8601 UTC>
- eol: lf
- files: <count>

## Files

### FILE src/app.py
```python
...content, LF line endings...
```

### FILE README.md [noeol]
```markdown
last line has no trailing newline
```

### DELETE old/file.txt

## Skipped

- assets/logo.png (binary)
- data/big.csv (over 1 MiB)
````

Rules:

- Line 1 is exactly `# m365-bundle v1`. A parser rejects anything else.
- Header lines are `- key: value`; unknown keys are ignored, `kind` is one of
  `input`, `output`, `audit`.
- A file section starts with a line matching
  `^### (FILE|DELETE) (.+?)(?: \[([a-z,]+)\])?$`. The only flag today is `noeol`
  (the content has no trailing newline).
- The line after `### FILE` opens a fence of N backticks (N >= 3) plus an optional
  info string. N is one more than the longest run of backticks in the content, so the
  closing line (exactly N backticks) cannot collide with content. The parser matches
  the closing fence by exact length.
- Content is UTF-8 without BOM, LF only. The packer converts CRLF to LF. The unpacker
  keeps the line-ending style of an existing target file (CRLF stays CRLF) and writes LF
  for new files.
- Binary files (NUL byte in the first 8 KiB, or a known binary extension) are listed
  under `## Skipped` with the reason, so the model knows they exist.
- `### DELETE <path>` removes the file on unpack. `## Skipped` is informational.

## Size guidance

`make-input.mjs` warns above 1 MiB per file and 15 MB in total (`--max-file`,
`--max-total` override). The 15 MB figure is the documented per-file attachment limit
of Copilot Studio file input; the Agent Builder limit is not documented and is recorded
under "Measured" in `m365-constraints.md` once known.
