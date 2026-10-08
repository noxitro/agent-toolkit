// The production export of m365-skill-pack holds the skill and nothing else, and refuses
// to write anything that names a third-party model route, opens a network connection or
// links outside the allow-list.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { scanFiles } from '../scripts/lib/export-m365.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'scripts', 'export-m365.mjs')

function exportTo(dir, ...extra) {
  return spawnSync(process.execPath, [CLI, dir, ...extra], { encoding: 'utf8' })
}

function tree(dir) {
  const out = {}
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else out[relative(dir, p).replace(/\\/g, '/')] = readFileSync(p)
    }
  }
  walk(dir)
  return out
}

test('export: only the skill, its two manifests, README, LICENSE and the export record', () => {
  const out = mkdtempSync(join(tmpdir(), 'm365export-'))
  const r = exportTo(out)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(readdirSync(out).sort(), ['.claude-plugin', '.gitattributes', '.gitignore', 'EXPORT.json', 'LICENSE', 'README.md', 'copilot', 'plugins'])
  const files = Object.keys(tree(out))
  for (const f of files) {
    assert.ok(
      f.startsWith('plugins/m365-skill-pack/') || f.startsWith('copilot/skills/m365-skill-pack/') ||
        ['.claude-plugin/marketplace.json', '.gitattributes', '.gitignore', 'EXPORT.json', 'LICENSE', 'README.md'].includes(f),
      f,
    )
  }
  // Byte-identical to the generated plugin and Copilot copies.
  const plugin = tree(join(ROOT, 'plugins', 'toolkit-core', 'skills', 'm365-skill-pack'))
  const exported = tree(join(out, 'plugins', 'm365-skill-pack', 'skills', 'm365-skill-pack'))
  assert.deepEqual(Object.keys(exported).sort(), Object.keys(plugin).sort())
  for (const k of Object.keys(plugin)) assert.ok(plugin[k].equals(exported[k]), k)
  const copilot = tree(join(ROOT, 'dist', 'copilot', 'skills', 'm365-skill-pack'))
  const exportedCopilot = tree(join(out, 'copilot', 'skills', 'm365-skill-pack'))
  assert.deepEqual(Object.keys(exportedCopilot).sort(), Object.keys(copilot).sort())
  const market = JSON.parse(readFileSync(join(out, '.claude-plugin', 'marketplace.json'), 'utf8'))
  assert.deepEqual(market.plugins.map((p) => p.source), ['./plugins/m365-skill-pack'])
  const record = JSON.parse(readFileSync(join(out, 'EXPORT.json'), 'utf8'))
  assert.equal(Object.keys(record.files).length, files.length - 1)
})

test('export: the scan rejects model routes, network calls and foreign URLs', () => {
  const f = (path, text) => ({ path, data: Buffer.from(text) })
  assert.deepEqual(scanFiles([f('a.md', 'see https://learn.microsoft.com/x'), f('b.py', 'import socket\n')]), [])
  const problems = scanFiles([
    f('a.md', 'run opencode with a free model'),
    f('b.mjs', 'await fetch(url)'),
    f('c.py', 'socket.create_connection(("1.1.1.1", 443))'),
    f('d.md', 'see https://example.com/page'),
    f('e.json', '{"M365_EMU_HUMAN": 1}'),
  ])
  for (const name of ['a.md', 'b.mjs', 'c.py', 'd.md', 'e.json']) assert.ok(problems.some((p) => p.startsWith(`${name}:`)), name)
})

test('export: --check reports drift, and a foreign directory is never overwritten', () => {
  const out = mkdtempSync(join(tmpdir(), 'm365export-'))
  assert.equal(exportTo(out).status, 0)
  assert.equal(exportTo(out, '--check').status, 0)
  appendFileSync(join(out, 'README.md'), 'edited by hand\n')
  writeFileSync(join(out, 'stray.txt'), 'x')
  const drift = exportTo(out, '--check')
  assert.equal(drift.status, 1)
  assert.match(drift.stdout, /changed {2}README\.md/)
  assert.match(drift.stdout, /extra {4}stray\.txt/)
  // Re-exporting repairs the export and leaves files it did not write alone.
  assert.equal(exportTo(out).status, 0)
  assert.equal(readFileSync(join(out, 'stray.txt'), 'utf8'), 'x')

  const foreign = mkdtempSync(join(tmpdir(), 'm365export-'))
  mkdirSync(join(foreign, 'src'))
  writeFileSync(join(foreign, 'src', 'app.py'), 'print(1)\n')
  const refused = exportTo(foreign)
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /no EXPORT\.json/)

  assert.equal(exportTo(join(ROOT, 'tmp-export')).status, 1)
})
