---
name: doc-context-build
description: Use when the user wants to collect an internal documentation site (a home URL whose pages form a tree) into a local cache, group the cached pages into per-topic Markdown bundles, and wrap them with writing rules into the context file(s) that are attached to a Microsoft 365 Copilot agent that writes guideline documents. Also use to check whether that cache has gone stale. Not for writing the guideline itself - that happens in Microsoft 365 Copilot.
---

<!-- Generated file - do not edit this copy; the next build overwrites it. It is generated from shared/skills/doc-context-build/SKILL.md in the agent-toolkit repository, which is not present alongside this file and must not be opened. -->

# Building the context for guideline writing

`<skill-dir>` is the directory holding this SKILL.md. The three scripts need Python 3.8+
(standard library only). A project is a folder with `docctx.json`, `manifest.json` and
`rules/` - copy `<skill-dir>/example/` to start one. Every path in the config is relative
to that folder; output goes to its `out_dir` (default `out/`).

The access token for the site is read from the environment variable named by
`token_env` (default `DOC_SITE_TOKEN`). Never put it in a file, never echo it, never
pass it on the command line. If it is missing the collector says so and requests without
credentials.

## 1. Collect (crawl into the cache)

```bash
python <skill-dir>/scripts/collect.py <project-dir>
```

Crawls from `root_url`, same host and under the root path only, to `max_depth`, skipping
paths that contain an `exclude` entry. Cached pages are re-requested conditionally
(ETag / Last-Modified) and compared by content hash, so a rerun only rewrites what
changed. Pages gone from the site move to `cache/_removed/`. Read `out/cache/changes.md`
(added / changed / removed) and tell the user what changed.

Staleness check without writing: `--dry-run` (exit 3 when the site differs from the
cache, 0 when current). Use it when the user asks whether the cache is still fresh.

## 2. Bundle (group pages by context)

```bash
python <skill-dir>/scripts/bundle.py <project-dir>
```

`manifest.json` maps URL path prefixes (and single pages) to named bundles and bundles
to guidelines. Writes `out/bundles/<name>.md` (front matter, source list with retrieval
dates, pages separated by `<!-- docctx:page URL -->` markers) and `out/bundles/impact.md`,
which lists the bundles and guidelines the last collect run touched. Report impact.md to
the user: it is the list of guidelines that may need rewriting.

## 3. Compose (rules + bundle = the file to attach)

```bash
python <skill-dir>/scripts/compose.py <project-dir> [--strict]
```

For each guideline: header, `rules/common.md`, `rules/<category>.md`, `rules/<guideline>.md`,
the bundle, then `rules/output-contract.md` at the very end. Over `split_chars` (default
30,000) the result is split at page boundaries into `part1..N` with a header telling the
agent to wait for all parts. Writes `out/context/<guideline>[.partN].md` and
`<guideline>.sources.json`. Bundles older than `stale_days` print a warning; `--strict`
skips them and exits 1.

## Handing over

Tell the user which files under `out/context/` to attach to the Microsoft 365 Copilot
agent (all parts of one guideline in one message), and quote the retrieval dates from the
compose output. Do not try to send them yourself: the agent has no API, and the cache
contains internal pages that must not leave the organisation's Copilot.

`<skill-dir>/build-context.bat <project-dir>` runs the three steps in order on Windows.
