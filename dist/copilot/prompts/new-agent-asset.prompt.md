---
description: Scaffold a new shared skill, command or agent in this toolkit, then regenerate the per-harness output.
mode: agent
---

<!-- Generated file - do not edit this copy; the next build overwrites it. It is generated from shared/commands/new-agent-asset.md in the agent-toolkit repository, which is not present alongside this file and must not be opened. -->

Scaffold a new asset in this repository from: ${input:args}

Expected input is a kind (`skill`, `command` or `agent`) and a name. If either is missing,
ask for it before creating anything.

1. Check the name is free. It must be lowercase words joined by single hyphens, at most 64
   characters, and unused by any existing asset under `shared/` - names are unique across all
   three kinds, not just within one.
2. Create the source file:
   - skill -> `shared/skills/<name>/SKILL.md`
   - command -> `shared/commands/<name>.md`
   - agent -> `shared/agents/<name>.md`
3. Write the frontmatter with `name`, `description` and `targets`. Default `targets` to all
   three harnesses, but drop `opencode` for a skill that only makes sense when the model
   triggers it on its own - this toolkit emits skills to OpenCode as slash commands (even
   though OpenCode itself can now load skills), so it would receive a command nobody types.
   A skill with bundled files cannot target `opencode` at all: a single command file cannot
   carry them, and `npm run validate` rejects it. Put anything harness-specific under `harness.<name>.frontmatter`, never at
   the top level.
4. Draft the body. Keep it about intent and quality bars rather than step-by-step procedure,
   and use `{{ARGS}}` wherever the invocation arguments belong.
5. Run `npm run check` and commit both the source and the regenerated output together.

Read `shared/skills/agent-asset-authoring/SKILL.md` first if the portability rules are not
already loaded in this session.
