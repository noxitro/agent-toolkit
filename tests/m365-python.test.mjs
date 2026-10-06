// Tests for the Python scripts that run inside the Microsoft 365 Copilot sandbox
// (shared/skills/m365-skill-pack/m365/skills/*/scripts/*.py), including a round trip
// against the local JavaScript tools make-input.mjs and unpack-output.mjs.
// Every test is skipped when no Python 3 interpreter is available.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACK = join(ROOT, 'shared/skills/m365-skill-pack')
const SKILLS = join(PACK, 'm365/skills')
const BUNDLE_IO = join(SKILLS, 'common/scripts/bundle_io.py')
const RUN_ROUND = join(SKILLS, 'implement/scripts/run_round.py')
const AUDIT = join(SKILLS, 'audit/scripts/audit_checks.py')
const PROBE = join(SKILLS, 'probe/scripts/probe_env.py')

function findPython() {
  for (const cmd of [['python'], ['py', '-3'], ['python3']]) {
    const r = spawnSync(cmd[0], [...cmd.slice(1), '--version'], { encoding: 'utf8' })
    if (r.status === 0 && /Python 3\./.test(`${r.stdout}${r.stderr}`)) return cmd
  }
  return null
}

const PY = findPython()
const NO_PY = 'no Python 3 interpreter found (tried python, py -3, python3)'

const TASK = `# TASK demo-task

## Goal

Add a shout() helper next to greet().

## Scope

- src/**

## Acceptance

- AC-1: every changed .py file compiles (py_compile).
- AC-2: src/app.py exposes shout() and src/new.py uses it.

## Constraints

- Do not add dependencies.

## Forbidden patterns

- print\\(

## Max rounds

3
`

const FIXTURE = {
  'src/app.py': 'def greet(name):\n    """Markdown fences like ```` must survive."""\n    return "hi " + name\n',
  'src/noeol.txt': 'last line without newline',
  'src/crlf.txt': 'one\r\ntwo\r\n',
  'src/old.txt': 'remove me\n',
  'src/pkg/mod.py': 'VALUE = 1\n',
  'assets/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00]),
}

function py(args, opts = {}) {
  return spawnSync(PY[0], [...PY.slice(1), ...args], {
    encoding: 'utf8',
    ...opts,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', ...(opts.env ?? {}) },
  })
}

function node(script, args) {
  return spawnSync(process.execPath, [join(PACK, 'scripts', script), ...args], { encoding: 'utf8' })
}

function ok(r, what) {
  assert.equal(r.status, 0, `${what} failed (exit ${r.status})\nstdout: ${r.stdout}\nstderr: ${r.stderr}`)
  return r
}

function writeTree(dir, files) {
  for (const [rel, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), data)
  }
}

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'm365py-'))
  const repo = join(tmp, 'repo')
  writeTree(repo, FIXTURE)
  const task = join(tmp, 'TASK.md')
  writeFileSync(task, TASK)
  return { tmp, repo, task }
}

function makeInput(env, format) {
  const out = join(env.tmp, `in-${format}`)
  const r = ok(node('make-input.mjs', ['--task', env.task, '--repo', env.repo, '--out', out, '--format', format, '--quiet']), `make-input --format ${format}`)
  const file = r.stdout.trim().split(/\r?\n/).pop()
  assert.ok(existsSync(file), `bundle ${file} exists`)
  return file
}

function unpack(bundle, work) {
  ok(py([BUNDLE_IO, 'unpack', bundle, work]), `bundle_io.py unpack ${bundle}`)
  return work
}

/** Work directory unpacked from a ZIP input bundle. */
function prepareWork(env, name = 'work') {
  return unpack(makeInput(env, 'zip'), join(env.tmp, name))
}

function listFiles(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name)
    if (e.isDirectory()) listFiles(abs, base, out)
    else out.push(abs.slice(base.length + 1).split(/[\\/]/).join('/'))
  }
  return out.sort()
}

function auditJson(text) {
  assert.ok(text.startsWith('# AUDIT'), 'AUDIT.md starts with # AUDIT')
  const m = /```json\s*\n([\s\S]*?)\n```/.exec(text)
  assert.ok(m, 'AUDIT.md has a json block')
  return JSON.parse(m[1])
}

function cleanup(env) {
  rmSync(env.tmp, { recursive: true, force: true })
}

test('every m365 Python script compiles with py_compile', (t) => {
  if (!PY) return t.skip(NO_PY)
  const files = listFiles(SKILLS).filter((p) => p.endsWith('.py')).map((p) => join(SKILLS, p))
  assert.ok(files.length >= 4, `found ${files.length} .py files`)
  const cache = mkdtempSync(join(tmpdir(), 'm365pyc-'))
  try {
    // PYTHONPYCACHEPREFIX keeps the .pyc files out of the source tree.
    ok(py(['-m', 'py_compile', ...files], { env: { PYTHONPYCACHEPREFIX: cache } }), 'py_compile')
    // The sandbox Python version is unknown; hold the scripts to 3.8 syntax.
    const check = 'import ast,sys\nfor p in sys.argv[1:]:\n    ast.parse(open(p,"rb").read(), p, feature_version=(3, 8))\n'
    ok(py(['-c', check, ...files]), 'ast.parse(feature_version=(3, 8))')
  } finally {
    rmSync(cache, { recursive: true, force: true })
  }
})

for (const inputFormat of ['zip', 'md']) {
  test(`round trip: make-input (${inputFormat}) -> bundle_io/run_round/audit_checks -> unpack-output`, (t) => {
    if (!PY) return t.skip(NO_PY)
    const env = setup()
    try {
      const work = unpack(makeInput(env, inputFormat), join(env.tmp, 'work'))

      // Unpacked repository files match the fixture.
      for (const [rel, data] of Object.entries(FIXTURE)) {
        const target = join(work, rel)
        if (inputFormat === 'md' && rel.endsWith('.png')) {
          assert.ok(!existsSync(target), 'binary file is skipped in the Markdown encoding')
          continue
        }
        let expected = Buffer.from(data)
        if (inputFormat === 'md') expected = Buffer.from(expected.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
        assert.deepEqual(readFileSync(target), expected, `${rel} is byte-identical`)
      }
      assert.ok(existsSync(join(work, '_m365/TASK.md')), '_m365/TASK.md unpacked')

      const manifest = JSON.parse(readFileSync(join(work, '_m365/manifest.json'), 'utf8'))
      assert.equal(manifest.schema, 'm365-manifest/1')
      assert.equal(manifest.task, 'demo-task')
      const expectedPaths = Object.keys(FIXTURE).filter((p) => inputFormat === 'zip' || !p.endsWith('.png')).sort()
      assert.deepEqual(Object.keys(manifest.files).sort(), expectedPaths)
      for (const h of Object.values(manifest.files)) assert.match(h, /^[0-9a-f]{64}$/)

      // One modification, one addition, one deletion.
      writeFileSync(join(work, 'src/app.py'), `${FIXTURE['src/app.py']}\n\ndef shout(name):\n    return greet(name).upper()\n`)
      // No trailing newline: the Markdown output must carry [noeol].
      writeFileSync(join(work, 'src/new.py'), 'from app import shout\n\nLOUD = shout("x")')
      unlinkSync(join(work, 'src/old.txt'))

      const status = JSON.parse(ok(py([BUNDLE_IO, 'status', work]), 'status').stdout)
      assert.deepEqual(status.added, ['src/new.py'])
      assert.deepEqual(status.modified, ['src/app.py'])
      assert.deepEqual(status.deleted, ['src/old.txt'])

      const started = JSON.parse(ok(py([RUN_ROUND, 'start', work]), 'run_round start').stdout)
      assert.deepEqual(started, { round: 1, max_rounds: 3, task: 'demo-task' })

      const checks = JSON.parse(ok(py([AUDIT, 'check', work]), 'audit check').stdout)
      assert.equal(checks.schema, 'm365-checks/1')
      assert.deepEqual(checks.acceptance.map((a) => a.id), ['AC-1', 'AC-2'])
      for (const c of checks.checks) assert.equal(c.status, 'PASS', `${c.id}: ${c.detail}`)
      assert.ok(existsSync(join(work, '_m365/checks.json')))

      const summary = JSON.parse(ok(py([AUDIT, 'report', work, '--round', '1', '--ac', 'AC-1=PASS', '--ac', 'AC-2=FAIL:src/new.py never asserts the result', '--notes', 'first try']), 'audit report').stdout)
      assert.equal(summary.verdict, 'FAIL')
      assert.equal(summary.final_round, 1)
      assert.equal(summary.max_rounds, 3)

      const finished = JSON.parse(ok(py([RUN_ROUND, 'finish', work, '--verdict', 'FAIL', '--notes', 'AC-2 open']), 'run_round finish').stdout)
      assert.deepEqual(finished.next, 'continue')
      assert.match(readFileSync(join(work, '_m365/ROUNDS.md'), 'utf8'), /^# ROUNDS demo-task\n[\s\S]*## Round 1\n[\s\S]*src\/new\.py/)

      for (const outExt of ['zip', 'md']) {
        const out = join(env.tmp, `out-demo-task-r1.${outExt}`)
        const packed = ok(py([BUNDLE_IO, 'pack', work, out]), `pack ${outExt}`).stdout
        assert.match(packed, /src\/app\.py/)
        assert.doesNotMatch(packed, /manifest\.json|state\.json/)

        const target = join(env.tmp, `apply-${outExt}`)
        cpSync(env.repo, target, { recursive: true })
        const r = node('unpack-output.mjs', [out, '--repo', target])
        assert.equal(r.status, 2, `unpack-output exits 2 on FAIL\nstdout: ${r.stdout}\nstderr: ${r.stderr}`)
        assert.deepEqual(readFileSync(join(target, 'src/app.py')), readFileSync(join(work, 'src/app.py')))
        assert.deepEqual(readFileSync(join(target, 'src/new.py')), readFileSync(join(work, 'src/new.py')))
        assert.ok(!existsSync(join(target, 'src/old.txt')), 'deleted file removed')
        assert.deepEqual(readFileSync(join(target, 'src/crlf.txt')), Buffer.from(FIXTURE['src/crlf.txt']), 'untouched file kept')
        const reports = join(target, '.m365/demo-task/reports')
        const audit = auditJson(readFileSync(join(reports, 'AUDIT.md'), 'utf8'))
        assert.equal(audit.schema, 'm365-audit/1')
        assert.equal(audit.verdict, 'FAIL')
        assert.deepEqual(audit.rounds.map((x) => x.round), [1])
        const ac2 = audit.rounds[0].checks.find((c) => c.id === 'AC-2')
        assert.equal(ac2.detail, 'src/new.py never asserts the result')
        assert.ok(existsSync(join(reports, 'ROUNDS.md')), 'ROUNDS.md travels with the bundle')
        assert.ok(!existsSync(join(reports, 'manifest.json')), 'manifest.json stays in the sandbox')

        // Standalone auditor: unpack the output bundle, audit it, return only AUDIT.md.
        const auditWork = join(env.tmp, `auditor-${outExt}`)
        assert.match(ok(py([BUNDLE_IO, 'unpack', out, auditWork]), 'auditor unpack').stdout, /kind: output/)
        assert.ok(existsSync(join(auditWork, '_m365/AUDIT.implementer.md')), 'implementer audit kept aside')
        assert.ok(!existsSync(join(auditWork, '_m365/AUDIT.md')), 'auditor starts a fresh AUDIT.md')
        const aChecks = JSON.parse(ok(py([AUDIT, 'check', auditWork]), 'auditor check').stdout)
        assert.deepEqual(aChecks.changed, { added: ['src/app.py', 'src/new.py'], modified: [], deleted: ['src/old.txt'] })
        for (const c of aChecks.checks) assert.equal(c.status, 'PASS', `auditor ${c.id}: ${c.detail}`)
        const aSummary = JSON.parse(ok(py([AUDIT, 'report', auditWork, '--round', '1', '--ac', 'AC-1=PASS', '--ac', 'AC-2=PASS']), 'auditor report').stdout)
        assert.equal(aSummary.verdict, 'PASS')
        assert.deepEqual(aSummary.rounds.map((x) => x.round), [1])
        const auditOut = join(env.tmp, `audit-demo-task.${outExt}`)
        assert.match(ok(py([BUNDLE_IO, 'pack', auditWork, auditOut, '--kind', 'audit']), 'auditor pack').stdout, /_m365\/AUDIT\.md/)
        const back = join(env.tmp, `audit-apply-${outExt}`)
        cpSync(env.repo, back, { recursive: true })
        const ra = node('unpack-output.mjs', [auditOut, '--repo', back, '--json'])
        assert.equal(ra.status, 0, `audit bundle PASS exits 0\nstdout: ${ra.stdout}\nstderr: ${ra.stderr}`)
        const applied = JSON.parse(ra.stdout)
        assert.equal(applied.task, 'demo-task')
        assert.deepEqual([applied.added, applied.modified, applied.deleted, applied.reports.length], [[], [], [], 1])
      }
    } finally {
      cleanup(env)
    }
  })
}

test('audit_checks check: syntax, json, forbidden and scope failures', (t) => {
  if (!PY) return t.skip(NO_PY)
  const env = setup()
  try {
    const work = prepareWork(env)
    writeTree(work, {
      'src/bad.py': 'def broken(:\n    pass\n',
      'src/printer.py': 'x = 1\nprint("debug")\n',
      'src/broken.json': '{"a": ',
      'docs/outside.md': 'outside the scope\n',
    })
    const out = join(env.tmp, 'checks.json')
    const stdout = JSON.parse(ok(py([AUDIT, 'check', work, '--out', out]), 'audit check').stdout)
    const result = JSON.parse(readFileSync(out, 'utf8'))
    assert.deepEqual(result, stdout)
    const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]))
    assert.equal(byId.syntax.status, 'FAIL')
    assert.match(byId.syntax.detail, /src\/bad\.py:1: /)
    assert.equal(byId.json.status, 'FAIL')
    assert.match(byId.json.detail, /src\/broken\.json/)
    assert.equal(byId.forbidden.status, 'FAIL')
    assert.match(byId.forbidden.detail, /src\/printer\.py:2: print\\\(/)
    assert.equal(byId.scope.status, 'FAIL')
    assert.match(byId.scope.detail, /docs\/outside\.md/)
    assert.doesNotMatch(byId.scope.detail, /src\//)
    assert.equal(byId.files.status, 'PASS')
    assert.deepEqual(result.changed.added, ['docs/outside.md', 'src/bad.py', 'src/broken.json', 'src/printer.py'])
  } finally {
    cleanup(env)
  }
})

test('audit_checks check: files FAIL when nothing changed', (t) => {
  if (!PY) return t.skip(NO_PY)
  const env = setup()
  try {
    const work = prepareWork(env)
    const result = JSON.parse(ok(py([AUDIT, 'check', work]), 'audit check').stdout)
    const files = result.checks.find((c) => c.id === 'files')
    assert.deepEqual(files, { id: 'files', status: 'FAIL', detail: 'nothing changed' })
  } finally {
    cleanup(env)
  }
})

test('audit_checks report: exit 2 when an AC is missing or a FAIL has no detail', (t) => {
  if (!PY) return t.skip(NO_PY)
  const env = setup()
  try {
    const work = prepareWork(env)
    writeFileSync(join(work, 'src/new.py'), 'X = 1\n')
    ok(py([AUDIT, 'check', work]), 'audit check')
    const missing = py([AUDIT, 'report', work, '--round', '1', '--ac', 'AC-1=PASS'])
    assert.equal(missing.status, 2)
    assert.match(missing.stderr, /AC-2/)
    const bare = py([AUDIT, 'report', work, '--round', '1', '--ac', 'AC-1=PASS', '--ac', 'AC-2=FAIL'])
    assert.equal(bare.status, 2)
    assert.ok(!existsSync(join(work, '_m365/AUDIT.md')), 'nothing written on a refused report')

    // Two rounds: the first is preserved when the second is reported.
    ok(py([AUDIT, 'report', work, '--round', '1', '--ac', 'AC-1=PASS', '--ac', 'AC-2=FAIL:no shout()']), 'report round 1')
    const second = JSON.parse(ok(py([AUDIT, 'report', work, '--round', '2', '--ac', 'AC-1=PASS', '--ac', 'AC-2=PASS']), 'report round 2').stdout)
    assert.equal(second.verdict, 'PASS')
    assert.equal(second.final_round, 2)
    assert.deepEqual(second.rounds.map((r) => [r.round, r.verdict]), [[1, 'FAIL'], [2, 'PASS']])
    const text = readFileSync(join(work, '_m365/AUDIT.md'), 'utf8')
    assert.deepEqual(auditJson(text), second)
    assert.match(text, /## Round 1\n[\s\S]*## Round 2\n/)
  } finally {
    cleanup(env)
  }
})

test('run_round start: exit 2 past max rounds', (t) => {
  if (!PY) return t.skip(NO_PY)
  const env = setup()
  try {
    const work = prepareWork(env)
    const codes = [1, 2, 3, 4].map(() => py([RUN_ROUND, 'start', work]).status)
    assert.deepEqual(codes, [0, 0, 0, 2])
    const state = JSON.parse(ok(py([RUN_ROUND, 'show', work]), 'show').stdout)
    assert.equal(state.schema, 'm365-state/1')
    assert.equal(state.round, 3)
    assert.equal(state.max_rounds, 3)
  } finally {
    cleanup(env)
  }
})

test('run_round finish: refuses a verdict that contradicts AUDIT.md', (t) => {
  if (!PY) return t.skip(NO_PY)
  const env = setup()
  try {
    const work = prepareWork(env)
    writeFileSync(join(work, 'src/new.py'), 'X = 1\n')
    ok(py([RUN_ROUND, 'start', work]), 'start')
    ok(py([AUDIT, 'report', work, '--round', '1', '--ac', 'AC-1=PASS', '--ac', 'AC-2=FAIL:missing']), 'report')
    assert.equal(py([RUN_ROUND, 'finish', work, '--verdict', 'PASS']).status, 2)
    const done = JSON.parse(ok(py([RUN_ROUND, 'finish', work, '--verdict', 'FAIL']), 'finish').stdout)
    assert.deepEqual(done, { round: 1, verdict: 'FAIL', next: 'continue', reason: 'verdict FAIL in round 1 of 3' })
  } finally {
    cleanup(env)
  }
})

test('bundle_io unpack: refuses unsafe paths and writes nothing', (t) => {
  if (!PY) return t.skip(NO_PY)
  const env = setup()
  try {
    const bundle = join(env.tmp, 'evil.md')
    writeFileSync(bundle, '# m365-bundle v1\n- task: evil\n- kind: input\n\n## Files\n\n### FILE ok.txt\n```text\nfine\n```\n\n### FILE ../escape.txt\n```text\nbad\n```\n')
    const work = join(env.tmp, 'evil-work')
    const r = py([BUNDLE_IO, 'unpack', bundle, work])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /unsafe path "\.\.\/escape\.txt"/)
    assert.ok(!existsSync(work), 'nothing written')
    assert.ok(!existsSync(join(env.tmp, 'escape.txt')))
  } finally {
    cleanup(env)
  }
})

test('probe_env.py runs and reports python_version', (t) => {
  if (!PY) return t.skip(NO_PY)
  const tmp = mkdtempSync(join(tmpdir(), 'm365probe-'))
  try {
    const out = join(tmp, 'probe-output.txt')
    const r = py([PROBE, '--out', out], { cwd: tmp, timeout: 120_000, env: { M365_PROBE_CANARY: 'canary-value-7f3a' } })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /python_version: 3\.\d+/)
    const text = readFileSync(out, 'utf8')
    assert.match(text, /python_version: /)
    assert.match(text, /== import matrix ==/)
    assert.match(text, /PASS json/)
    assert.match(text, /== network ==\nnetwork: /)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
