# Bundle format (sandbox copy)

A bundle carries repository files in and results out. `scripts/bundle_io.py` reads and
writes both encodings; you normally never build one by hand.

## Paths

Relative to the repository root, `/` separated, no `..`, no leading `/`, no drive
letter, no `.git` segment. `_m365/` is reserved for protocol files:

| Path | Meaning |
| --- | --- |
| `_m365/TASK.md` | the task: goal, scope, acceptance criteria, constraints, forbidden patterns, max rounds |
| `_m365/CONVENTIONS/*` | the project's conventions files, follow them |
| `_m365/manifest.json` | hashes of the input files (written by `unpack`, used to detect changes) |
| `_m365/state.json` | round counter (written by `run_round.py`) |
| `_m365/ROUNDS.md` | round log for humans |
| `_m365/AUDIT.md` | audit verdict, JSON block first |
| `_m365/DELETED.txt` | deleted paths, one per line (ZIP output only) |

## ZIP encoding

Plain `.zip`, store or deflate, no directory entries. `pack --full` (what the agent
instructions use) writes every repository file plus the `_m365/` files and the input
`_m365/manifest.json`, so an auditor can tell real changes from untouched files. Plain
`pack` writes only added and modified files plus the `_m365/` files. Deleted paths go
to `_m365/DELETED.txt` in both modes.

## Markdown encoding

````text
# m365-bundle v1
- task: <slug>
- kind: input | output | audit
- round: <N>
- files: <count>

## Files

### FILE src/app.py
```python
content with LF line endings
```

### FILE README.md [noeol]
```markdown
last line without newline
```

### DELETE old/file.txt

## Skipped

- assets/logo.png (binary)
````

The fence is one backtick longer than the longest backtick run inside the content, so
the closing line never collides. `[noeol]` means the content has no trailing newline.
