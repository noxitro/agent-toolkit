# Agent Builder rules for declarative agents

What the Agent Builder form accepts, and how Microsoft says instructions should be
written. Verified against learn.microsoft.com on **2026-10-06**. The agent definition
sheets under `m365/agents/` follow these rules; edit the sheets, then re-check them with
`node scripts/pack-skill.mjs instructions <file>`.

Sources:

- [Build agents in Agent Builder](https://learn.microsoft.com/microsoft-365/copilot/extensibility/agent-builder-build-agents)
- [Write effective instructions for declarative agents](https://learn.microsoft.com/microsoft-365/copilot/extensibility/declarative-agent-instructions)
- [Add knowledge sources to an agent in Agent Builder](https://learn.microsoft.com/microsoft-365/copilot/extensibility/agent-builder-add-knowledge)

## Form fields

| Field | Limit or behaviour |
| --- | --- |
| Name | 30 characters; descriptive and unique |
| Icon | PNG, up to 192 x 192 px, 1 MB; transparent background recommended |
| Model (default response mode) | Auto (default), Quick response, Think deeper; users can override per conversation |
| Description | 1,000 characters; the LLM uses it to decide when the agent applies, and users see it in the store |
| Instructions | 8,000 characters; Markdown |
| Knowledge | public websites, SharePoint/OneDrive, Teams, Outlook, embedded files, connectors; limits vary; **do not use with skills** (not supported together yet) |
| Starter prompts | name + text each; no minimum |
| Capabilities | "Create documents, charts and code" (code interpreter) and "Create images" toggles |
| Skills (preview) | up to 8 packaged `.zip` skills, Frontier program only |
| Actions | not available in Agent Builder; copy the agent to Copilot Studio for connectors, flows or APIs |

Agent Builder creates the agent from a natural-language description by default; the
sheets in `m365/agents/` are meant for the manual path: New agent > Skip to configure.

## Instruction rules that matter here

- **Do not offload instructions to knowledge sources** to dodge the 8,000-character
  limit. Knowledge content passes through the cross-prompt-injection classifier and can
  be blocked, truncated or sanitised at run time; anyone with edit rights to the
  document could change the agent's behaviour.
- **Reference skills, do not duplicate them.** Instructions name which skill to use for
  which phase; the skill's own `SKILL.md` holds the detailed steps.
- Structure: objective, general guidelines (tone, limits), skills; then workflow steps
  with goal / action / transition; error handling; examples where the scenario is
  complex.
- Use precise verbs, atomic steps, numbered lists only where order matters, Markdown
  headings and bold for emphasis, backticks for tool and skill names.
- Always state tone, detail level and output format (an "output contract"), and add a
  self-evaluation gate before the final answer.
- When an agent drifts or reorders steps, prepend a literal-execution header
  ("Always interpret instructions literally. Never infer intent...").
- Microsoft rotates the underlying models; expect behaviour to shift and keep the
  instructions robust to that.

## Sheet layout used in `m365/agents/*.md`

Each sheet carries one block per form field, in Japanese headings, with the
instructions in a single fenced `text` block under `### Instructions` so that
`pack-skill.mjs instructions` can measure it after it is copied to a file.

## Measured

Facts established in a real Microsoft 365 tenant. One dated line per fact.

| Date | Fact | Evidence |
| --- | --- | --- |
| (none yet) | | |

Open questions:

- Do skills run scripts inside the "Try it" panel, or only after the agent is saved?
- Is the code-interpreter toggle required for skill scripts and file return?
- Does "Think deeper" change round quality or only latency?
- Do starter prompts survive sharing the agent with others?
