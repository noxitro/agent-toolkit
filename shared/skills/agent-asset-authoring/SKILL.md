---
name: agent-asset-authoring
description: Use when writing or reviewing a skill, command, agent or prompt that has to work on more than one agent harness (Claude Code, OpenCode, GitHub Copilot). Covers the shared frontmatter contract, the per-harness frontmatter that must stay in the harness block, argument placeholders, and the portability traps that make an asset silently do nothing on one harness while working on another.
targets: [claude, opencode, copilot]
harness:
  claude:
    frontmatter:
      allowed-tools: Read, Grep, Glob
---

# Authoring portable agent assets

Every asset in this repository is written once under `shared/` and generated into a
per-harness shape by `scripts/build.mjs`. Portability is a property of how the source is
written, not something the build can add afterwards.

## The shared contract

```yaml
---
name: my-asset            # lowercase words joined by hyphens, <= 64 chars,
                          # identical to the directory (skills) or file (commands, agents) name
description: One sentence saying WHEN to use this, <= 1024 chars
targets: [claude, opencode, copilot]
harness:                  # optional, per-harness escape hatch
  claude:
    frontmatter: { allowed-tools: Read, Grep }
  opencode:
    frontmatter: { agent: build }
  copilot:
    skip: true            # drop this asset from one harness without forking it
---
```

Only `name`, `description` and `targets` are portable. Anything else - tool allowlists,
model pins, permissions, `mode` - is harness-specific and belongs in `harness.<name>.frontmatter`,
where the build copies it verbatim into the emitted file.

## Rules that hold on all three harnesses

1. **`description` is a trigger, not a summary.** It is the only text the harness sees when
   deciding whether to load the asset. Write it as "Use when ...". A description that
   describes the *contents* rather than the *situation* fires unreliably.
2. **Name and location must agree.** `name` has to match the directory name for skills and
   the file name for commands and agents. A mismatch is accepted silently by some harnesses
   and rejected by others; `npm run validate` rejects it here.
3. **Do not stack assets speculatively.** Every installed description is held in context on
   every turn, so each extra asset dilutes trigger accuracy for all the others. Ship what is
   actually used.
4. **Write arguments as `{{literal:ARGS}}`.** The build substitutes the native placeholder per
   harness (`$ARGUMENTS`, or `${input:args}` for Copilot prompt files). Text that has to
   *mention* the token - like this sentence - writes `{{literal:` + `ARGS}}`, which the build
   emits as the literal token on every harness.
5. **Reference bundled files by relative path.** Extra files in a skill directory
   (`references/`, `scripts/`) are copied verbatim next to `SKILL.md`, so a relative link
   resolves identically everywhere.

## Portability traps

- **OpenCode has no skill mechanism.** A skill targeting `opencode` is emitted as a global
  command instead, so it becomes explicitly invoked (`/name`) rather than model-triggered.
  If an asset only makes sense when the model picks it up on its own, drop `opencode` from
  `targets` rather than shipping a command nobody will type.
- **OpenCode permissions delete tools rather than narrow them.** A catch-all `deny` in an
  agent's `permission` block removes the tool from the agent entirely, and `tools: { bash: true }`
  does not bring it back. The failure is silent: the agent reports success while never having
  had the capability. Grant explicitly, and verify by observing a real tool call.
- **Copilot prompt files are workspace-scoped by default.** `.github/prompts/` is only found
  inside the open repository. Cross-workspace availability needs the user-level location
  (VS Code `%APPDATA%\Code\User\prompts\`), and being *discoverable* is still separate from
  being *allowed to read* a path outside the workspace.
- **Hooks never travel.** Hook wiring is harness-specific and is not part of the shared
  asset contract. Keep it in the harness-specific directories and document it.

## Before committing

```bash
npm run check
```

`validate` enforces the shared contract; `build --check` fails if the committed per-harness
output no longer matches the source.
