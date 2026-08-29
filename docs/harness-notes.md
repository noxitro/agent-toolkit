# Harness notes

Where each harness looks for assets, and the traps that make a correct-looking asset do
nothing. Version-dependent statements are dated; treat them as a snapshot rather than a
guarantee.

## Claude Code

**Install.** `/plugin marketplace add noxitro/agent-toolkit`, then
`/plugin install toolkit-core@agent-toolkit`. The marketplace manifest lives at
`.claude-plugin/marketplace.json` and points at `./plugins/toolkit-core`, whose own manifest
is `plugins/toolkit-core/.claude-plugin/plugin.json`.

**Discovery inside a plugin.** `skills/<name>/SKILL.md`, `commands/<name>.md`,
`agents/<name>.md`. Skills are model-triggered from their `description`; commands are typed
as `/<name>`; agents are dispatched as subagents.

**Notes.**

- A skill's `name` must match its directory name, and the description is the only text
  consulted when deciding whether to load it.
- Hooks are harness-specific and are deliberately not part of the shared asset contract.

## OpenCode

**Install.** Copy `dist/opencode/.` into `~/.config/opencode/` for every project, or into
`.opencode/` inside one project. Both `agent/` and `command/` are read from there, and unlike
Copilot prompt files the global location is genuinely workspace-independent.

**Notes.**

- **There is no skill mechanism.** A skill targeting `opencode` is emitted as a global
  command, which means it must be typed rather than being picked up by the model. If an
  asset only earns its keep through automatic triggering, drop `opencode` from its `targets`.
- **Permissions delete tools rather than narrow them.** A catch-all `deny` in an agent's
  `permission` block removes the tool from that agent entirely, and `tools: { bash: true }`
  does not restore it. The failure is silent — the agent keeps reporting success while never
  having had the capability. Grant explicitly and confirm by observing a real tool call.
- OpenCode also reads `~/.claude/CLAUDE.md` for Claude Code compatibility, so global Claude
  instructions apply unless they are overridden in `~/.config/opencode/AGENTS.md`.
- Paths outside the project are governed by the `external_directory` permission, which
  defaults to `ask` — and a non-interactive `opencode run` auto-rejects it. An asset that
  reads an absolute path outside the project will look like it is "ignoring instructions"
  when it is actually being blocked.
- On Windows, npm installs `opencode` as a PowerShell shim; launchers that need a real
  executable should use `%APPDATA%\npm\opencode.cmd`.

## GitHub Copilot

**Install.** Copy `dist/copilot/.` into the `.github/` directory of the repository where the
assets should be available.

| Asset | Repository location | User-level location |
| --- | --- | --- |
| Skill | `.github/skills/<name>/SKILL.md` | `~/.copilot/skills/`, `~/.claude/skills/`, `~/.agents/skills/` |
| Prompt | `.github/prompts/<name>.prompt.md` | VS Code: `%APPDATA%\Code\User\prompts\` |
| Agent | `.github/agents/<name>.agent.md` | `%USERPROFILE%\.github\agents\` |

**Notes.**

- **Prompt files are workspace-scoped by default.** A prompt installed into one repository
  does not appear in another. The user-level VS Code location fixes availability — but being
  *discoverable* is separate from being *allowed to read* a path outside the workspace.
- Copilot adopted the agentskills.io skill format (`SKILL.md` + frontmatter), which is why a
  single source can serve both Copilot and Claude Code. The shared constraints —
  `name` lowercase-hyphenated, ≤ 64 characters, matching the directory name; `description`
  ≤ 1024 characters — are enforced by `npm run validate`.
- Because `~/.claude/skills/` is one of the personal skill discovery locations, a skill
  installed for Claude Code becomes discoverable by Copilot too. An asset that assumes a
  particular harness is executing it needs to say so in its own text; the install location
  will not enforce it.
- Copilot CLI reads `CLAUDE.md` directly, so a repository already carrying Claude
  instructions works without modification.

### Visual Studio 2026 (not VS Code)

Same generated payload, different invocation and version floors (as of 2026-08; version
dependent):

- Prompt files work from VS 2022 17.10+, but are invoked as `#prompt:<file>` or from the ➕
  icon. `/` completion for custom prompts arrives in Visual Studio 2026.
- Custom instructions are **off by default**: Tools → Options → GitHub → Copilot → Copilot
  Chat → "Enable custom instructions…".
- Custom agents (`.github/agents/*.agent.md`) require VS 2026 18.4+; Agent Skills require
  VS 2026 18.5+.
- Prompt-file discovery starts from the open repository's `.github/prompts`, so the
  copy-into-`.github/` install is the supported path here.

## Cross-harness

- **Hooks never travel.** Hook wiring is per-harness (Claude Code: `.claude/settings*.json`
  in the working directory; Copilot CLI/cloud: `.github/hooks/<skill>.json`) and is not
  generated from `shared/`.
- **Do not stack assets speculatively.** Every installed description is in context on every
  turn, so each additional asset dilutes trigger accuracy for all the others and widens the
  surface that has to be reviewed.
