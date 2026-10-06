---
name: probe
description: Use when asked to probe, inspect or report the script sandbox environment (Python version, platform, working directory, where attachments are placed, which modules import, whether the network is reachable). Runs scripts/probe_env.py and returns its complete output as a text file.
---

# probe

This skill measures the sandbox so that the other skills can rely on facts instead of
assumptions. Run it once when the agent is first set up, and again after platform
changes.

## How to run

1. Execute `scripts/probe_env.py`. It takes no arguments and never fails on purpose:
   every section catches its own errors and reports them.
2. If a file was attached to the conversation, also run
   `scripts/probe_env.py --out probe-output.txt` after noting where the attachment is
   visible from the script (the report lists candidate directories and any `.zip` or
   `.md` files it finds).
3. Return the full report as a text file named `probe-output.txt`. Do not summarise or
   shorten it; the person reading it needs every line, including failures.
4. In the chat answer, state in one sentence whether the attached file was visible to
   the script, and under which path.
