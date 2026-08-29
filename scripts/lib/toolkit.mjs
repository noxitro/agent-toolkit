// Shared helpers for the build / validate scripts.
// Single source of truth: shared/**. Everything under plugins/*/{skills,commands,agents}
// and dist/** is generated from it by scripts/build.mjs.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import YAML from 'yaml'

// Resolved from the invocation directory rather than this file's location, so the same
// toolchain can be run from a sibling repository that reuses this build.
export const ROOT = process.env.AGENT_TOOLKIT_ROOT ? resolve(process.env.AGENT_TOOLKIT_ROOT) : process.cwd()
export const SHARED = join(ROOT, 'shared')

// Per-repository settings, so this file stays byte-identical across the repositories that
// share the toolchain. Keeping it identical is what makes moving an asset between them a
// plain file move.
const config = existsSync(join(ROOT, 'toolkit.config.json'))
  ? JSON.parse(readFileSync(join(ROOT, 'toolkit.config.json'), 'utf8'))
  : {}

/** Claude Code plugin that receives every `claude` target asset. */
export const CLAUDE_PLUGIN = config.claudePlugin ?? 'toolkit-core'

/** Output roots this build owns. Anything here is wiped and regenerated. */
export const OWNED_DIRS = [
  join('plugins', CLAUDE_PLUGIN, 'skills'),
  join('plugins', CLAUDE_PLUGIN, 'commands'),
  join('plugins', CLAUDE_PLUGIN, 'agents'),
  'dist',
]

export const KINDS = ['skills', 'commands', 'agents']
export const TARGETS = ['claude', 'opencode', 'copilot']

// agentskills.io constraints, also enforced by Claude Code and Copilot (VS 2026 18.5+).
export const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const NAME_MAX = 64
export const DESC_MAX = 1024

/** `{{ARGS}}` in a shared body becomes the harness-native argument placeholder. */
const PLACEHOLDERS = {
  claude: { ARGS: '$ARGUMENTS' },
  opencode: { ARGS: '$ARGUMENTS' },
  copilot: { ARGS: '${input:args}' },
}

const BANNER = (src) =>
  `<!-- GENERATED FILE - DO NOT EDIT. Source: ${src}. Run \`npm run build\` after editing the source. -->`

export function splitFrontmatter(text, file) {
  if (!text.startsWith('---')) throw new Error(`${file}: missing YAML frontmatter`)
  const end = text.indexOf('\n---', 3)
  if (end === -1) throw new Error(`${file}: unterminated YAML frontmatter`)
  const raw = text.slice(4, end)
  const body = text.slice(text.indexOf('\n', end + 1) + 1)
  let data
  try {
    data = YAML.parse(raw) ?? {}
  } catch (e) {
    throw new Error(`${file}: invalid YAML frontmatter - ${e.message}`)
  }
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file}: frontmatter must be a mapping`)
  return { data, body }
}

function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

function listFiles(dir, ext) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(ext))
      .map((e) => e.name)
  } catch {
    return []
  }
}

export function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, base, out)
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join('/'))
  }
  return out
}

export function relPath(abs) {
  return relative(ROOT, abs).split(sep).join('/')
}

/**
 * Discover every asset under shared/. Returns a list of
 * { kind, name, sourceFile, sourceDir, extraFiles, data, body }.
 */
export function loadAssets() {
  const assets = []

  for (const name of listDirs(join(SHARED, 'skills'))) {
    const dir = join(SHARED, 'skills', name)
    const file = join(dir, 'SKILL.md')
    const text = readFileSync(file, 'utf8')
    const { data, body } = splitFrontmatter(text, relPath(file))
    assets.push({
      kind: 'skills',
      name,
      sourceFile: relPath(file),
      sourceDir: dir,
      extraFiles: walk(dir).filter((f) => f !== 'SKILL.md'),
      data,
      body,
    })
  }

  for (const kind of ['commands', 'agents']) {
    for (const fileName of listFiles(join(SHARED, kind), '.md')) {
      const file = join(SHARED, kind, fileName)
      const text = readFileSync(file, 'utf8')
      const { data, body } = splitFrontmatter(text, relPath(file))
      assets.push({
        kind,
        name: fileName.replace(/\.md$/, ''),
        sourceFile: relPath(file),
        sourceDir: null,
        extraFiles: [],
        data,
        body,
      })
    }
  }

  return assets.sort((a, b) => (a.kind + a.name).localeCompare(b.kind + b.name))
}

/** Canonical-schema validation. Returns an array of human-readable problem strings. */
export function validateAsset(asset) {
  const problems = []
  const at = asset.sourceFile
  const { name, description, targets, harness } = asset.data

  if (typeof name !== 'string' || !name) {
    problems.push(`${at}: \`name\` is required`)
  } else {
    if (name !== asset.name)
      problems.push(
        `${at}: \`name: ${name}\` must match the ${asset.kind === 'skills' ? 'directory' : 'file'} name \`${asset.name}\``
      )
    if (name.length > NAME_MAX) problems.push(`${at}: \`name\` is ${name.length} chars (max ${NAME_MAX})`)
    if (!NAME_RE.test(name)) problems.push(`${at}: \`name\` must be lowercase alphanumeric words joined by single hyphens`)
  }

  if (typeof description !== 'string' || !description.trim()) problems.push(`${at}: \`description\` is required`)
  else if (description.length > DESC_MAX) problems.push(`${at}: \`description\` is ${description.length} chars (max ${DESC_MAX})`)

  if (!Array.isArray(targets) || targets.length === 0) problems.push(`${at}: \`targets\` must be a non-empty list`)
  else
    for (const t of targets)
      if (!TARGETS.includes(t)) problems.push(`${at}: unknown target \`${t}\` (allowed: ${TARGETS.join(', ')})`)

  if (harness !== undefined) {
    if (typeof harness !== 'object' || harness === null || Array.isArray(harness)) {
      problems.push(`${at}: \`harness\` must be a mapping`)
    } else {
      for (const [t, cfg] of Object.entries(harness)) {
        if (!TARGETS.includes(t)) problems.push(`${at}: \`harness.${t}\` is not a known target`)
        if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) {
          problems.push(`${at}: \`harness.${t}\` must be a mapping`)
          continue
        }
        for (const key of Object.keys(cfg))
          if (!['frontmatter', 'emit', 'skip'].includes(key)) problems.push(`${at}: unknown key \`harness.${t}.${key}\``)
      }
    }
  }

  if (!asset.body.trim()) problems.push(`${at}: body is empty`)

  return problems
}

function renderBody(body, target) {
  let out = body
  for (const [token, value] of Object.entries(PLACEHOLDERS[target])) out = out.replaceAll(`{{${token}}}`, value)
  return out.trim() + '\n'
}

function render(frontmatter, body, target, sourceFile) {
  const yaml = YAML.stringify(frontmatter, { lineWidth: 0 }).trimEnd()
  return `---\n${yaml}\n---\n\n${BANNER(sourceFile)}\n\n${renderBody(body, target)}`
}

/**
 * OpenCode has no skill mechanism, so a skill targeting opencode is emitted as a
 * global command instead. Everything else maps one-to-one.
 */
function defaultEmit(kind, target) {
  if (kind === 'skills') return target === 'opencode' ? 'command' : 'skill'
  if (kind === 'commands') return 'command'
  return 'agent'
}

/**
 * Compute every generated file for one asset.
 * Returns [{ path, contents }] for rendered files and [{ path, copyFrom }] for verbatim copies.
 */
export function emit(asset) {
  const files = []
  const targets = asset.data.targets ?? []
  const harness = asset.data.harness ?? {}
  const { name, description } = asset.data

  for (const target of targets) {
    const cfg = harness[target] ?? {}
    if (cfg.skip) continue
    const extra = cfg.frontmatter ?? {}
    const emitAs = cfg.emit ?? defaultEmit(asset.kind, target)
    const outDir = {
      claude: join('plugins', CLAUDE_PLUGIN),
      opencode: join('dist', 'opencode'),
      copilot: join('dist', 'copilot'),
    }[target]

    if (emitAs === 'skill') {
      const dir = join(outDir, 'skills', name)
      files.push({
        path: join(dir, 'SKILL.md'),
        contents: render({ name, description, ...extra }, asset.body, target, asset.sourceFile),
      })
      for (const f of asset.extraFiles) files.push({ path: join(dir, f), copyFrom: join(asset.sourceDir, f) })
    } else if (emitAs === 'command') {
      const file =
        target === 'copilot'
          ? join(outDir, 'prompts', `${name}.prompt.md`)
          : join(outDir, target === 'claude' ? 'commands' : 'command', `${name}.md`)
      files.push({ path: file, contents: render({ description, ...extra }, asset.body, target, asset.sourceFile) })
    } else if (emitAs === 'agent') {
      const file =
        target === 'copilot'
          ? join(outDir, 'agents', `${name}.agent.md`)
          : join(outDir, target === 'claude' ? 'agents' : 'agent', `${name}.md`)
      const fm = target === 'opencode' ? { description, ...extra } : { name, description, ...extra }
      files.push({ path: file, contents: render(fm, asset.body, target, asset.sourceFile) })
    } else {
      throw new Error(`${asset.sourceFile}: unknown emit kind \`${emitAs}\` for target \`${target}\``)
    }
  }

  return files
}

export function isDir(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
