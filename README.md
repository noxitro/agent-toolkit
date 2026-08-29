# agent-toolkit

A plugin repository that bundles skills, agents, commands, and more for
platforms such as Claude, GitHub Copilot, and OpenCode.

## Repository layout

This repository is managed with a plugin-oriented folder structure.
Each plugin lives under `/plugins/<plugin-name>/` and is split by content type.

```text
plugins/
├── claude/
│   ├── agents/
│   ├── commands/
│   └── skills/
├── github-copilot/
│   ├── agents/
│   ├── commands/
│   └── skills/
└── opencode/
    ├── agents/
    ├── commands/
    └── skills/
```

## Plugin conventions

- `plugins/<plugin-name>/agents/`: agent definitions for the plugin
- `plugins/<plugin-name>/commands/`: command definitions for the plugin
- `plugins/<plugin-name>/skills/`: skill definitions for the plugin

Add new platforms by creating a new directory under `/plugins/` that follows the
same structure.
