#!/usr/bin/env node
// Validate the single-source assets and the plugin manifests.
// Runs in CI before the drift check; also useful locally before committing.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, ensureRoot, isDir, loadAssets, relPath, validateAsset } from './lib/toolkit.mjs'

ensureRoot('validate')

const report = { problems: [], warnings: [] }
const problems = report.problems

// ---------------------------------------------------------------- shared assets
const assets = loadAssets(report)
if (assets.length === 0 && problems.length === 0) problems.push(`shared/: no assets found under ${join(ROOT, 'shared')}`)
for (const asset of assets) problems.push(...validateAsset(asset))

// An asset that hardcodes a machine-specific absolute path cannot be published, and has to
// be edited every time the target moves. Paths belong in a registry or an argument, not in
// the asset. Environment-variable forms (%APPDATA%, ~/.claude/...) stay allowed.
const MACHINE_PATHS = [
  { re: /(?:^|[\s"'`(=])[A-Za-z]:[\\/]/, what: 'a drive-letter absolute path' },
  { re: /\/(?:home|Users)\/[A-Za-z0-9._-]+\//, what: 'a user home absolute path' },
]
// Every text file of the asset is scanned: the whole source file (frontmatter included, so
// harness.<target>.frontmatter is covered) and each bundled file of a skill. Files with a
// NUL byte are treated as binary and skipped.
function scanForMachinePaths(at, text) {
  text.split(/\r?\n/).forEach((line, i) => {
    for (const { re, what } of MACHINE_PATHS)
      if (re.test(line)) problems.push(`${at}:${i + 1}: ${what} is hardcoded - use a registry or an argument instead: ${line.trim()}`)
  })
}
for (const asset of assets) {
  scanForMachinePaths(asset.sourceFile, asset.text ?? `${asset.data.description ?? ''}\n${asset.body}`)
  for (const rel of asset.extraFiles) {
    const abs = join(asset.sourceDir, rel)
    const bytes = readFileSync(abs)
    if (bytes.includes(0)) continue
    scanForMachinePaths(relPath(abs), bytes.toString('utf8'))
  }
}

// A skill and a command with the same name collide once the skill is emitted as an
// OpenCode command, so names must be unique across kinds.
const byName = new Map()
for (const asset of assets) {
  const seen = byName.get(asset.name)
  if (seen) problems.push(`${asset.sourceFile}: name \`${asset.name}\` is already used by ${seen}`)
  else byName.set(asset.name, asset.sourceFile)
}

// ------------------------------------------------------------------- manifests
function readJson(rel) {
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) {
    problems.push(`${rel}: missing`)
    return null
  }
  try {
    return JSON.parse(readFileSync(abs, 'utf8'))
  } catch (e) {
    problems.push(`${rel}: invalid JSON - ${e.message}`)
    return null
  }
}

const pkg = readJson('package.json')
const marketplace = readJson('.claude-plugin/marketplace.json')

if (marketplace) {
  if (!marketplace.name) problems.push('.claude-plugin/marketplace.json: `name` is required')
  if (!marketplace.owner?.name) problems.push('.claude-plugin/marketplace.json: `owner.name` is required')
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0)
    problems.push('.claude-plugin/marketplace.json: `plugins` must be a non-empty list')
  if (pkg && marketplace.metadata?.version && marketplace.metadata.version !== pkg.version)
    problems.push(
      `.claude-plugin/marketplace.json: \`metadata.version: ${marketplace.metadata.version}\` does not match package.json \`${pkg.version}\``
    )

  for (const entry of marketplace.plugins ?? []) {
    const at = `.claude-plugin/marketplace.json (plugin \`${entry.name ?? '?'}\`)`
    if (!entry.name) problems.push(`${at}: \`name\` is required`)
    if (pkg && entry.version && entry.version !== pkg.version)
      problems.push(`${at}: \`version: ${entry.version}\` does not match package.json \`${pkg.version}\``)
    if (!entry.source) {
      problems.push(`${at}: \`source\` is required`)
      continue
    }
    if (typeof entry.source !== 'string' || !entry.source.startsWith('./')) {
      // Remote sources are legal in the marketplace schema but this repo ships local ones.
      problems.push(`${at}: \`source\` must be a repo-relative path starting with ./`)
      continue
    }
    const dir = join(ROOT, entry.source)
    if (!isDir(dir)) {
      problems.push(`${at}: source directory \`${entry.source}\` does not exist`)
      continue
    }
    const manifestRel = `${entry.source.replace(/^\.\//, '')}/.claude-plugin/plugin.json`
    const manifest = readJson(manifestRel)
    if (!manifest) continue
    if (manifest.name !== entry.name)
      problems.push(`${manifestRel}: \`name: ${manifest.name}\` does not match the marketplace entry \`${entry.name}\``)
    if (!manifest.description) problems.push(`${manifestRel}: \`description\` is required`)
    if (!manifest.version) problems.push(`${manifestRel}: \`version\` is required`)
    else if (pkg && manifest.version !== pkg.version)
      problems.push(`${manifestRel}: \`version: ${manifest.version}\` does not match package.json \`${pkg.version}\``)
  }
}

// ---------------------------------------------------------------------- report
for (const w of report.warnings) console.warn(`warning: ${w}`)
if (problems.length) {
  console.error(`${problems.length} problem(s) found:`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

const counts = assets.reduce((acc, a) => ({ ...acc, [a.kind]: (acc[a.kind] ?? 0) + 1 }), {})
const summary = ['skills', 'commands', 'agents'].map((k) => `${counts[k] ?? 0} ${k}`).join(', ')
console.log(`OK - ${assets.length} shared assets (${summary}), manifests consistent.`)
