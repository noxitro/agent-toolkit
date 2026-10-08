// scripts/install-assets.mjs: harness presets (scripts/lib/presets.mjs) and the copy / link installs.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { allPresetDirs, normalize, presetEntries, staleLinks, userDirs } from '../scripts/lib/presets.mjs'

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
  assert.deepEqual(pairs(presetEntries(root, ['claude'], opts)), [
    ['.claude/agents/a1.md', 'plugins/core/agents/a1.md'],
    ['.claude/commands/c1.md', 'plugins/core/commands/c1.md'],
    ['.claude/skills/s1', 'plugins/core/skills/s1'],
  ])
})

test('opencode preset uses the plural folders and honours XDG_CONFIG_HOME', () => {
  assert.deepEqual(pairs(presetEntries(root, ['opencode'], opts)), [
    ['.config/opencode/agents/a1.md', 'dist/opencode/agent/a1.md'],
    ['.config/opencode/commands/c1.md', 'dist/opencode/command/c1.md'],
    ['.config/opencode/commands/s1.md', 'dist/opencode/command/s1.md'],
  ])
  const xdg = presetEntries(root, ['opencode'], { ...opts, env: { XDG_CONFIG_HOME: join(home, 'cfg') } })
  assert.ok(xdg.every((l) => l.path.startsWith(join(home, 'cfg', 'opencode'))))
})

test('copilot preset skips hidden files and drops what ~/.claude already serves', () => {
  assert.deepEqual(pairs(presetEntries(root, ['copilot'], opts)), [
    ['.config/Code/User/prompts/c1.prompt.md', 'dist/copilot/prompts/c1.prompt.md'],
    ['.copilot/agents/a1.agent.md', 'dist/copilot/agents/a1.agent.md'],
    ['.copilot/skills/s1', 'dist/copilot/skills/s1'],
  ])
  const both = pairs(presetEntries(root, ['claude', 'copilot'], opts)).map(([p]) => p)
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

// End to end: run the installer against a throwaway repository and home folder.

const script = join(process.cwd(), 'scripts', 'install-assets.mjs')

function fixture(name) {
  const repo = join(tmp, name, 'repo')
  const userHome = join(tmp, name, 'home')
  const put = (p, text) => {
    mkdirSync(join(repo, p, '..'), { recursive: true })
    writeFileSync(join(repo, p), text)
  }
  put('package.json', JSON.stringify({ name: '@acme/kit', version: '1.0.0' }))
  put('toolkit.config.json', JSON.stringify({ claudePlugin: 'core' }))
  put('plugins/core/skills/s1/SKILL.md', 'skill v1')
  put('plugins/core/skills/s1/scripts/run.mjs', 'run')
  put('plugins/core/agents/a1.md', 'agent v1')
  mkdirSync(userHome, { recursive: true })
  const run = (...args) => {
    const r = spawnSync(process.execPath, [script, ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: userHome, USERPROFILE: userHome },
    })
    return { code: r.status, out: r.stdout + r.stderr }
  }
  const home = (p) => join(userHome, p)
  return { repo, home, put, run, state: () => JSON.parse(readFileSync(home('.agent-toolkit/acme-kit.json'), 'utf8')) }
}

test('copy install, update, local edits and uninstall', () => {
  const f = fixture('copy')
  let r = f.run('--setup', 'claude')
  assert.equal(r.code, 0, r.out)
  assert.ok(lstatSync(f.home('.claude/skills/s1')).isDirectory())
  assert.equal(readFileSync(f.home('.claude/skills/s1/scripts/run.mjs'), 'utf8'), 'run')
  assert.equal(f.state().mode, 'copy')
  assert.deepEqual(f.state().harnesses, ['claude'])
  assert.equal(f.run('--check').code, 0)

  // A new version updates untouched copies.
  f.put('plugins/core/skills/s1/SKILL.md', 'skill v2')
  assert.equal(f.run('--check').code, 1)
  assert.equal(f.run().code, 0)
  assert.equal(readFileSync(f.home('.claude/skills/s1/SKILL.md'), 'utf8'), 'skill v2')

  // A copy edited by the user is not overwritten without --force.
  writeFileSync(f.home('.claude/agents/a1.md'), 'my notes')
  f.put('plugins/core/agents/a1.md', 'agent v2')
  r = f.run()
  assert.equal(r.code, 1)
  assert.match(r.out, /edited since it was installed/)
  assert.equal(readFileSync(f.home('.claude/agents/a1.md'), 'utf8'), 'my notes')
  assert.equal(f.run('--force').code, 0)
  assert.equal(readFileSync(f.home('.claude/agents/a1.md'), 'utf8'), 'agent v2')

  // A deleted asset is removed; an unrelated file in the same folder is left alone.
  writeFileSync(f.home('.claude/agents/mine.md'), 'mine')
  rmSync(join(f.repo, 'plugins/core/agents/a1.md'))
  assert.equal(f.run().code, 0)
  assert.ok(!existsSync(f.home('.claude/agents/a1.md')))
  assert.ok(existsSync(f.home('.claude/agents/mine.md')))

  assert.equal(f.run('--remove').code, 0)
  assert.ok(!existsSync(f.home('.claude/skills/s1')))
  assert.ok(existsSync(f.home('.claude/agents/mine.md')))
  assert.ok(!existsSync(f.home('.agent-toolkit/acme-kit.json')))
})

test('a file the installer did not create is never overwritten, unless identical', () => {
  const f = fixture('foreign')
  mkdirSync(f.home('.claude/agents'), { recursive: true })
  writeFileSync(f.home('.claude/agents/a1.md'), 'someone else')
  let r = f.run('--setup', 'claude')
  assert.equal(r.code, 1)
  assert.match(r.out, /did not create/)
  assert.equal(readFileSync(f.home('.claude/agents/a1.md'), 'utf8'), 'someone else')

  writeFileSync(f.home('.claude/agents/a1.md'), 'agent v1')
  r = f.run()
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /now tracked/)
})

test('switching between copy and link mode replaces what was installed', () => {
  const f = fixture('modes')
  assert.equal(f.run('--setup', 'claude').code, 0)
  let r = f.run('--link')
  assert.equal(r.code, 0, r.out)
  assert.ok(lstatSync(f.home('.claude/skills/s1')).isSymbolicLink())
  assert.equal(f.state().mode, 'link')
  assert.deepEqual(f.state().copies, {})

  // Deselecting a harness removes its links.
  assert.equal(f.run('--setup', 'opencode').code, 0)
  assert.ok(!existsSync(f.home('.claude/skills/s1')))

  assert.equal(f.run('--setup', 'claude', '--copy').code, 0)
  assert.ok(lstatSync(f.home('.claude/skills/s1')).isDirectory())
  assert.equal(f.run('--check').code, 0)
})
