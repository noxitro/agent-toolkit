// Harness presets of scripts/install-links.mjs (scripts/lib/links.mjs).

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { allPresetDirs, normalize, presetLinks, staleLinks, userDirs } from '../scripts/lib/links.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'links-'))
after(() => rmSync(tmp, { recursive: true, force: true }))

const root = join(tmp, 'repo')
const home = join(tmp, 'home')
const opts = { claudePlugin: 'core', home, platform: 'linux', env: {} }

function touch(p) {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, '')
}
touch(join(root, 'plugins/core/skills/s1/SKILL.md'))
touch(join(root, 'plugins/core/commands/c1.md'))
touch(join(root, 'plugins/core/agents/a1.md'))
touch(join(root, 'dist/opencode/command/c1.md'))
touch(join(root, 'dist/opencode/command/s1.md'))
touch(join(root, 'dist/opencode/agent/a1.md'))
touch(join(root, 'dist/copilot/skills/s1/SKILL.md'))
touch(join(root, 'dist/copilot/agents/a1.agent.md'))
touch(join(root, 'dist/copilot/prompts/c1.prompt.md'))
touch(join(root, 'dist/copilot/prompts/.hidden'))

const pairs = (links) => links.map((l) => [l.path.slice(home.length + 1), l.target]).sort()

test('claude preset links every plugin asset into ~/.claude', () => {
  assert.deepEqual(pairs(presetLinks(root, ['claude'], opts)), [
    ['.claude/agents/a1.md', 'plugins/core/agents/a1.md'],
    ['.claude/commands/c1.md', 'plugins/core/commands/c1.md'],
    ['.claude/skills/s1', 'plugins/core/skills/s1'],
  ])
})

test('opencode preset uses the plural folders and honours XDG_CONFIG_HOME', () => {
  assert.deepEqual(pairs(presetLinks(root, ['opencode'], opts)), [
    ['.config/opencode/agents/a1.md', 'dist/opencode/agent/a1.md'],
    ['.config/opencode/commands/c1.md', 'dist/opencode/command/c1.md'],
    ['.config/opencode/commands/s1.md', 'dist/opencode/command/s1.md'],
  ])
  const xdg = presetLinks(root, ['opencode'], { ...opts, env: { XDG_CONFIG_HOME: join(home, 'cfg') } })
  assert.ok(xdg.every((l) => l.path.startsWith(join(home, 'cfg', 'opencode'))))
})

test('copilot preset skips hidden files and drops what ~/.claude already serves', () => {
  assert.deepEqual(pairs(presetLinks(root, ['copilot'], opts)), [
    ['.config/Code/User/prompts/c1.prompt.md', 'dist/copilot/prompts/c1.prompt.md'],
    ['.copilot/agents/a1.agent.md', 'dist/copilot/agents/a1.agent.md'],
    ['.copilot/skills/s1', 'dist/copilot/skills/s1'],
  ])
  const both = pairs(presetLinks(root, ['claude', 'copilot'], opts)).map(([p]) => p)
  assert.ok(!both.some((p) => p.startsWith('.copilot/')))
  assert.ok(both.includes('.config/Code/User/prompts/c1.prompt.md'))
})

test('VS Code prompts folder follows the platform', () => {
  assert.equal(userDirs({ ...opts, platform: 'win32', env: { APPDATA: 'C:\\AppData' } }).copilot.prompts, join('C:\\AppData', 'Code', 'User', 'prompts'))
  assert.equal(userDirs({ ...opts, platform: 'darwin' }).copilot.prompts, join(home, 'Library', 'Application Support', 'Code', 'User', 'prompts'))
})

test('staleLinks reports only undeclared symlinks into the repository', () => {
  const skills = join(home, '.claude', 'skills')
  mkdirSync(skills, { recursive: true })
  const other = join(tmp, 'other-clone')
  mkdirSync(other)
  symlinkSync(join(root, 'plugins/core/skills/s1'), join(skills, 's1'), 'dir')
  symlinkSync(join(root, 'plugins/core/skills/gone'), join(skills, 'gone'), 'dir')
  symlinkSync(other, join(skills, 'theirs'), 'dir')
  mkdirSync(join(skills, 'real'))

  const keep = new Set([normalize(join(skills, 's1'), 'linux')])
  const stale = staleLinks(allPresetDirs(opts), root, keep, 'linux')
  assert.deepEqual(stale.map((s) => s.path), [join(skills, 'gone')])
})
