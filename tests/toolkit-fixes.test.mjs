// Tests for the build / validate / install-links toolchain (scripts/**).
// Every run happens in a throwaway fixture root under the OS temp directory; the real
// scripts are executed against it with cwd and AGENT_TOOLKIT_ROOT, so the repository's
// own shared/, dist/ and plugins/ are never touched.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { splitFrontmatter, validateAsset } from '../scripts/lib/toolkit.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = (name) => join(REPO, 'scripts', name)
const POSIX_LINKS = process.platform !== 'win32'

const SKILL = '---\nname: demo-skill\ndescription: Use when testing the build.\ntargets: [claude, copilot]\n---\n\nDo the thing.\n'
const COMMAND = '---\nname: demo-command\ndescription: Run the demo.\ntargets: [claude, opencode, copilot]\n---\n\nRun with {{ARGS}}.\n'

function write(root, rel, content) {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), content)
}

/** A minimal toolkit root: config, manifests and the given shared/ files. */
function fixture(shared = { 'shared/skills/demo-skill/SKILL.md': SKILL, 'shared/commands/demo-command.md': COMMAND }) {
  const root = mkdtempSync(join(tmpdir(), 'toolkit-fix-'))
  write(root, 'toolkit.config.json', '{ "claudePlugin": "toolkit-core" }\n')
  write(root, 'package.json', '{ "name": "fixture", "version": "1.0.0" }\n')
  write(
    root,
    '.claude-plugin/marketplace.json',
    JSON.stringify({ name: 'fixture', owner: { name: 'me' }, plugins: [{ name: 'toolkit-core', source: './plugins/toolkit-core' }] })
  )
  write(root, 'plugins/toolkit-core/.claude-plugin/plugin.json', JSON.stringify({ name: 'toolkit-core', description: 'd', version: '1.0.0' }))
  for (const [rel, content] of Object.entries(shared)) write(root, rel, content)
  return root
}

function run(script, root, args = [], env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT(script), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, AGENT_TOOLKIT_ROOT: root, ...env },
  })
  return { status: r.status, out: r.stdout + r.stderr }
}

const asset = (data, extra = {}) => ({
  kind: 'commands',
  name: 'demo',
  sourceFile: 'shared/commands/demo.md',
  data: { name: 'demo', description: 'd', targets: ['claude', 'opencode'], ...data },
  body: 'body',
  ...extra,
})

// ------------------------------------------------------------------ 1. wrong root
test('build refuses a directory that is not a toolkit root and leaves its dist/ alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'toolkit-notroot-'))
  write(dir, 'dist/keep.txt', 'precious\n')
  for (const env of [{ AGENT_TOOLKIT_ROOT: '' }, {}]) {
    const r = run('build.mjs', dir, [], env)
    assert.notEqual(r.status, 0, r.out)
    assert.match(r.out, /not an agent-toolkit repository/)
    assert.equal(readFileSync(join(dir, 'dist/keep.txt'), 'utf8'), 'precious\n')
  }
  for (const script of ['validate.mjs', 'install-links.mjs']) {
    const r = run(script, dir)
    assert.notEqual(r.status, 0, `${script}: ${r.out}`)
    assert.match(r.out, /not an agent-toolkit repository/)
  }
})

test('build refuses a root with zero shared assets before deleting anything', () => {
  const root = fixture({})
  mkdirSync(join(root, 'shared'), { recursive: true })
  write(root, 'dist/keep.txt', 'precious\n')
  const r = run('build.mjs', root)
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /no shared assets found/)
  assert.ok(existsSync(join(root, 'dist/keep.txt')))
  assert.notEqual(run('validate.mjs', root).status, 0)
})

test('build and check succeed in a valid fixture root', () => {
  const root = fixture()
  const b = run('build.mjs', root)
  assert.equal(b.status, 0, b.out)
  assert.ok(existsSync(join(root, 'dist/opencode/command/demo-command.md')))
  assert.equal(run('validate.mjs', root).status, 0)
  assert.equal(run('build.mjs', root, ['--check']).status, 0)
})

// ---------------------------------------------------------- 5. dropped extra files
test('a skill with bundled files cannot be emitted as an OpenCode command', () => {
  const skill = SKILL.replace('[claude, copilot]', '[claude, opencode, copilot]')
  const root = fixture({ 'shared/skills/demo-skill/SKILL.md': skill, 'shared/skills/demo-skill/references/notes.md': '# n\n' })
  const v = run('validate.mjs', root)
  assert.equal(v.status, 1, v.out)
  assert.match(v.out, /emitted for `opencode` as a single command file, which would drop its 1 bundled file\(s\) \(references\/notes\.md\)/)
  assert.equal(run('build.mjs', root).status, 1)

  const skipped = skill.replace('targets: [claude, opencode, copilot]', 'targets: [claude, opencode, copilot]\nharness:\n  opencode:\n    skip: true')
  write(root, 'shared/skills/demo-skill/SKILL.md', skipped)
  assert.equal(run('validate.mjs', root).status, 0)
})

// ------------------------------------------------------------- 6. symlinks / strays
test('symlinks in shared/ are errors, not silently dropped', { skip: !POSIX_LINKS && 'needs symlink support' }, () => {
  const root = fixture()
  write(root, 'outside.md', '# o\n')
  symlinkSync(join(root, 'outside.md'), join(root, 'shared/skills/demo-skill/linked.md'))
  const v = run('validate.mjs', root)
  assert.equal(v.status, 1, v.out)
  assert.match(v.out, /shared\/skills\/demo-skill\/linked\.md: is a symlink/)
  assert.equal(run('build.mjs', root).status, 1)
})

test('build --check reports stray symlinks and empty directories in the output', { skip: !POSIX_LINKS && 'needs symlink support' }, () => {
  const root = fixture()
  assert.equal(run('build.mjs', root).status, 0)
  mkdirSync(join(root, 'dist/copilot/empty/deeper'), { recursive: true })
  symlinkSync(join(root, 'package.json'), join(root, 'dist/opencode/command/stray.md'))
  const r = run('build.mjs', root, ['--check'])
  assert.equal(r.status, 1, r.out)
  assert.match(r.out, /stray +dist\/opencode\/command\/stray\.md \(symlink\)/)
  assert.match(r.out, /stray +dist\/copilot\/empty\/ \(empty directory\)/)
  assert.doesNotMatch(r.out, /empty\/deeper/)
})

// ----------------------------------------------------------- 7. harness validation
test('harness blocks: frontmatter must be a mapping without name/description, keys must be targets', () => {
  const cases = [
    [{ harness: { claude: { frontmatter: 'tools: Read' } } }, /`harness\.claude\.frontmatter` must be a mapping/],
    [{ harness: { claude: { frontmatter: ['a'] } } }, /`harness\.claude\.frontmatter` must be a mapping/],
    [{ harness: { claude: { frontmatter: { name: 'x' } } } }, /`harness\.claude\.frontmatter\.name` is not allowed/],
    [{ harness: { opencode: { frontmatter: { description: 'x' } } } }, /`harness\.opencode\.frontmatter\.description` is not allowed/],
    [{ harness: { copilot: { skip: true } } }, /`harness\.copilot` configures a harness that is not in `targets`/],
    [{ harness: { claude: { emit: 'prompt' } } }, /`harness\.claude\.emit: prompt` is not one of skill, command, agent/],
    [{ harness: { claude: { skip: 'yes' } } }, /`harness\.claude\.skip` must be true or false/],
  ]
  for (const [data, re] of cases) {
    const problems = validateAsset(asset(data))
    assert.ok(problems.some((p) => re.test(p)), `${JSON.stringify(data)}:\n${problems.join('\n')}`)
  }
  assert.deepEqual(validateAsset(asset({ harness: { claude: { frontmatter: { model: 'x' }, emit: 'command', skip: false } } })), [])
})

// ----------------------------------------------------------------- 8. frontmatter
test('splitFrontmatter: closing fence handling', () => {
  assert.deepEqual(splitFrontmatter('---\nname: a\n---', 'f'), { data: { name: 'a' }, body: '' })
  assert.deepEqual(splitFrontmatter('---\nname: a\n---\nbody\n', 'f'), { data: { name: 'a' }, body: 'body\n' })
  assert.deepEqual(splitFrontmatter('---\r\nname: a\r\n--- \r\nbody', 'f'), { data: { name: 'a' }, body: 'body' })
  assert.deepEqual(splitFrontmatter('---\n---\nbody', 'f'), { data: {}, body: 'body' })
  assert.throws(() => splitFrontmatter('---\nname: a\n----\nbody\n', 'f'), /unterminated/)
  assert.throws(() => splitFrontmatter('---\nname: a\n--- x\nbody\n', 'f'), /unterminated/)
  assert.throws(() => splitFrontmatter('----\nname: a\n---\n', 'f'), /missing YAML frontmatter/)
})

// ------------------------------------------------------------ 12. validate scope
test('validate scans bundled files and harness frontmatter for machine-specific paths', () => {
  const root = fixture({
    'shared/skills/demo-skill/SKILL.md': SKILL.replace('---\n\n', 'harness:\n  claude:\n    frontmatter:\n      hint: "C:\\\\tools\\\\x"\n---\n\n'),
    'shared/skills/demo-skill/references/notes.md': '# n\n\nSee /home/alice/project/file.txt\n',
    'shared/skills/demo-skill/assets/blob.bin': Buffer.from([0, 1, 2, 0x2f, 0x68]),
  })
  const v = run('validate.mjs', root)
  assert.equal(v.status, 1, v.out)
  assert.match(v.out, /shared\/skills\/demo-skill\/references\/notes\.md:3: a user home absolute path/)
  assert.match(v.out, /shared\/skills\/demo-skill\/SKILL\.md:\d+: a drive-letter absolute path/)
})

test('a skill directory without SKILL.md is a clear error; stray files in shared/commands warn', () => {
  const root = fixture({
    'shared/skills/demo-skill/SKILL.md': SKILL,
    'shared/skills/broken/notes.md': '# n\n',
    'shared/commands/demo-command.md': COMMAND,
    'shared/commands/notes.txt': 'x\n',
    'shared/commands/sub/other.md': COMMAND,
  })
  const v = run('validate.mjs', root)
  assert.equal(v.status, 1, v.out)
  assert.match(v.out, /shared\/skills\/broken: skill directory has no SKILL\.md/)
  assert.doesNotMatch(v.out, /ENOENT|at .*toolkit\.mjs/)
  assert.match(v.out, /warning: shared\/commands\/notes\.txt: skipped/)
  assert.match(v.out, /warning: shared\/commands\/sub: skipped/)
})

// ------------------------------------------------------------- 11. install-links
test('install-links: relative link targets, ~user, and replacing a wrong link', { skip: !POSIX_LINKS && 'needs symlink support' }, () => {
  const root = fixture()
  assert.equal(run('build.mjs', root).status, 0)
  const home = mkdtempSync(join(tmpdir(), 'toolkit-home-'))
  const target = 'plugins/toolkit-core/skills/demo-skill'
  write(
    root,
    'toolkit.config.json',
    JSON.stringify({ claudePlugin: 'toolkit-core', links: [{ path: '~/links/demo-skill', target }] })
  )
  const linkPath = join(home, 'links/demo-skill')
  mkdirSync(dirname(linkPath), { recursive: true })

  // An existing *relative* link that is correct when read from the link's own directory
  // (but not from the cwd, which is the fixture root).
  symlinkSync(relative(dirname(linkPath), join(root, target)), linkPath)
  const ok = run('install-links.mjs', root, ['--check'], { HOME: home })
  assert.equal(ok.status, 0, ok.out)

  // A wrong link is replaced in place; no temporary entries are left behind.
  write(root, 'toolkit.config.json', JSON.stringify({ claudePlugin: 'toolkit-core', links: [{ path: '~/links/demo-skill', target: 'dist' }] }))
  assert.equal(run('install-links.mjs', root, ['--check'], { HOME: home }).status, 1)
  const fixed = run('install-links.mjs', root, [], { HOME: home })
  assert.equal(fixed.status, 0, fixed.out)
  assert.match(fixed.out, /replaced a link to/)
  assert.ok(lstatSync(linkPath).isSymbolicLink())
  assert.equal(readlinkSync(linkPath), join(root, 'dist'))
  assert.deepEqual(readdirSync(dirname(linkPath)), ['demo-skill'])

  // "~user/..." is not the current user's home, and is refused rather than created as a
  // literal "~nobody" directory under the current one.
  write(root, 'toolkit.config.json', JSON.stringify({ claudePlugin: 'toolkit-core', links: [{ path: '~nobody/x', target: 'dist' }] }))
  for (const args of [['--check'], []]) {
    const tilde = run('install-links.mjs', root, args, { HOME: home })
    assert.equal(tilde.status, 1, tilde.out)
    assert.match(tilde.out, /~nobody\/x[\s\S]*only ~ and ~\/ are expanded/)
    assert.ok(!existsSync(join(home, 'nobody')) && !existsSync(join(root, '~nobody')))
  }
})

// --------------------------------------------------------------- 2-4. workflows
test('workflows: no expression interpolation in release shell, lychee exit code from step outputs', () => {
  const release = readFileSync(join(REPO, '.github/workflows/release.yml'), 'utf8')
  for (const block of release.split(/\n\s+run: \|\n/).slice(1)) {
    const script = block.split(/\n\s+- (?:name|uses):/)[0]
    assert.doesNotMatch(script, /\$\{\{/, script)
  }
  assert.doesNotMatch(release, /zip -r artifacts\/\w+\.zip dist\//)
  const links = readFileSync(join(REPO, '.github/workflows/link-check.yml'), 'utf8')
  assert.doesNotMatch(links, /env\.lychee_exit_code/)
  assert.match(links, /steps\.lychee\.outputs\.exit_code/)
  assert.match(links, /issue-number:/)
})
