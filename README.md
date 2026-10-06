# agent-toolkit

Skills, agents, commands and workflows for coding agents — written once, shipped to
**Claude Code**, **OpenCode** and **GitHub Copilot** (VS Code, CLI, Visual Studio 2026).

Each harness only discovers assets at its own fixed paths, so "shared" cannot mean one
physical directory that all three read. Instead every asset is authored once under
[`shared/`](shared/) and a build step generates the per-harness shape. The generated output
is committed, so users install through each harness's normal path with no build step, and CI
fails if it ever drifts from the source.

## Supported harnesses

| Role | Claude Code | OpenCode | GitHub Copilot |
| --- | --- | --- | --- |
| Skill | `skills/<name>/SKILL.md` | *(no skill mechanism — emitted as a command)* | `.github/skills/<name>/SKILL.md` |
| Command / prompt | `commands/<name>.md` | `command/<name>.md` | `.github/prompts/<name>.prompt.md` |
| Subagent | `agents/<name>.md` | `agent/<name>.md` | `.github/agents/<name>.agent.md` |
| Distribution | plugin marketplace | copy into `~/.config/opencode/` | copy into `.github/` |

See [docs/harness-notes.md](docs/harness-notes.md) for the per-harness details, version
requirements and known traps.

## Layout

```text
.claude-plugin/marketplace.json   Claude Code marketplace manifest
shared/                           SINGLE SOURCE — edit only here
  skills/<name>/SKILL.md          (plus optional references/, scripts/ copied verbatim)
  commands/<name>.md
  agents/<name>.md
plugins/toolkit-core/             GENERATED — Claude Code plugin payload
  .claude-plugin/plugin.json      (hand-written)
  skills/ commands/ agents/       (generated)
dist/                             GENERATED — copy-in payloads
  opencode/{agent,command}/
  copilot/{skills,prompts,agents}/
scripts/                          build + validate
toolkit.config.json               per-repository build settings
docs/                             per-harness notes
```

`scripts/` and `toolkit.config.json` are written so the same toolchain can be dropped into a
sibling repository (an incubation repo for assets that are not ready to publish yet) without
edits — only `claudePlugin` differs. Keeping the toolchain byte-identical is what makes
graduating an asset a plain file move plus a rebuild.

Everything under `dist/` and `plugins/*/{skills,commands,agents}` is regenerated from
scratch on every build. Do not edit it — edits are wiped and CI rejects them.

## Install

### Claude Code

```bash
/plugin marketplace add noxitro/agent-toolkit
```

```bash
/plugin install toolkit-core@agent-toolkit
```

### OpenCode

Copy the payload into the global config directory (all projects) or into `.opencode/` in one
project. OpenCode reads both `agent/` and `command/` from there.

```bash
cp -r dist/opencode/. ~/.config/opencode/
```

### GitHub Copilot (VS Code / CLI)

Copy the payload into the repository where you want it available:

```bash
cp -r dist/copilot/. .github/
```

For availability across every workspace instead of one repository, put the prompt files in
the user-level location — see [docs/harness-notes.md](docs/harness-notes.md).

## Authoring an asset

Create the source under `shared/`, then run `npm run check` and commit the source together
with the regenerated output.

```yaml
---
name: my-asset            # lowercase words joined by hyphens, ≤ 64 chars, matches the
                          # directory name (skills) or file name (commands, agents)
description: Use when …   # ≤ 1024 chars; this is the trigger text the harness matches on
targets: [claude, opencode, copilot]
harness:                  # optional per-harness escape hatch
  claude:
    frontmatter:          # merged verbatim into the generated frontmatter
      allowed-tools: Read, Grep
  opencode:
    frontmatter:
      mode: subagent
  copilot:
    skip: true            # drop this asset from one harness without forking it
---
```

Only `name`, `description` and `targets` are portable. Everything else — tool allowlists,
model pins, permissions, `mode` — is harness-specific and belongs in
`harness.<name>.frontmatter`. Write invocation arguments as `{{ARGS}}`; the build substitutes
the native placeholder (`$ARGUMENTS`, or `${input:args}` for Copilot prompt files).

The `agent-asset-authoring` skill in this repo carries the same contract plus the
portability traps, so the agent you are working with can load it directly.

### How each source maps to output

| Source | `claude` | `opencode` | `copilot` |
| --- | --- | --- | --- |
| `shared/skills/x/SKILL.md` | `plugins/toolkit-core/skills/x/SKILL.md` | `dist/opencode/command/x.md` | `dist/copilot/skills/x/SKILL.md` |
| `shared/commands/x.md` | `plugins/toolkit-core/commands/x.md` | `dist/opencode/command/x.md` | `dist/copilot/prompts/x.prompt.md` |
| `shared/agents/x.md` | `plugins/toolkit-core/agents/x.md` | `dist/opencode/agent/x.md` | `dist/copilot/agents/x.agent.md` |

Asset names are unique across all three kinds, because a skill and a command with the same
name would collide in the OpenCode command directory.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run validate` | Shared-asset contract, name/location agreement, `name` ≤ 64 and `description` ≤ 1024, unique names, no hardcoded machine paths, manifest and version consistency |
| `npm run build` | Regenerates every owned output directory from `shared/` |
| `npm run build:check` | Fails if the committed output does not match the source (missing, stale or orphaned files) |
| `npm run check` | `validate` + `build:check` — run this before committing |
| `npm test` | Unit tests for scripts that ship inside skills (currently the `m365-skill-pack` ZIP writer, bundle format, package validator and sandbox-side Python scripts; Python tests skip when no interpreter is on PATH) |

## CI

| Workflow | Trigger | What it enforces |
| --- | --- | --- |
| [`ci.yml`](.github/workflows/ci.yml) | push to `main`, PR | `npm run validate`, `npm run build:check`, `npm test`, markdownlint |
| [`link-check.yml`](.github/workflows/link-check.yml) | PR touching Markdown, weekly | lychee link check; a scheduled failure opens an issue instead of failing the run |
| [`release.yml`](.github/workflows/release.yml) | tag `v*` | tag matches `package.json`, full `npm run check`, publishes a release with `opencode.zip` / `copilot.zip` |

## Versioning

`package.json` is the single version source. `validate` fails if
`plugins/*/.claude-plugin/plugin.json` or `.claude-plugin/marketplace.json` disagree with it,
and the release workflow fails if the tag disagrees. To release: bump all three, commit, then
push a `vX.Y.Z` tag.

## License

[MIT](LICENSE)
