// Tests for the skill scout (m365-org-skills/scout). No network: fake upstream repositories
// are created with `git init` in a temp directory and fetched through file:// URLs. Checks
// the verdicts and reasons of `scan`, the refusals of `adopt` and `build`, that the zips
// pass the Agent Builder packer, and that import-upstream.mjs refuses symlinks and missing
// files without touching an existing package.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assembleSkillMd } from '../m365-org-skills/scout/import-upstream.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCOUT = join(ROOT, 'm365-org-skills/scout/scout.mjs')
const IMPORTER = join(ROOT, 'm365-org-skills/scout/import-upstream.mjs')
const PACKER = join(ROOT, 'shared/skills/m365-skill-pack/scripts/pack-skill.mjs')
const TP = join(ROOT, 'm365-org-skills/third-party')
const TMP = mkdtempSync(join(tmpdir(), 'm365-scout-'))
const UP = join(TMP, 'upstream')
const WORK = join(TMP, 'work')
const SOURCES = join(TMP, 'sources.json')
after(() => rmSync(TMP, { recursive: true, force: true }))

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
}
function git(cwd, args, input) {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, input, encoding: 'utf8', env: GIT_ENV })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

const MIT = 'MIT License\n\nCopyright (c) 2026 Example\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software...\n'
const APACHE = '                                 Apache License\n                           Version 2.0, January 2004\n                        http://www.apache.org/licenses/\n'
const PROPRIETARY = '(c) 2026 Example Corp. All rights reserved.\n\nADDITIONAL RESTRICTIONS: users may not reproduce, distribute or create derivative works.\n'

const skillMd = (name, description, body = 'Do the task step by step.\n') => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}`

/** Create a git repository from { path: content } and an optional list of symlink entries. */
function makeRepo(name, files, links = []) {
  const dir = join(UP, name)
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  git(dir, ['add', '-A'])
  // A symlink recorded in the index without creating one on disk (no privilege needed).
  for (const { path, target } of links) {
    const sha = git(dir, ['hash-object', '-w', '--stdin'], target)
    git(dir, ['update-index', '--add', '--cacheinfo', `120000,${sha},${path}`])
  }
  git(dir, ['commit', '-q', '-m', 'init'])
  return pathToFileURL(dir).href
}

function scout(args) {
  return spawnSync(process.execPath, [SCOUT, ...args, '--dir', WORK, '--sources', SOURCES], { encoding: 'utf8' })
}

let report
const rec = (path) => {
  const r = report.skills.find((s) => s.path === path)
  assert.ok(r, `no record for ${path}`)
  return r
}
const msgs = (r, level) => r.findings.filter((f) => !level || f.level === level).map((f) => f.msg).join('\n')

before(() => {
  const mitUrl = makeRepo('fake-skills', {
    LICENSE: MIT,
    'skills/ok-skill/SKILL.md': skillMd('ok-skill', 'Summarise a meeting transcript into decisions and action items.'),
    'skills/ok-skill/references/guide.md': '# Guide\n\nKeep it short.\n',
    'skills/ok-skill/README.md': '# Gallery readme\n',
    'skills/needs-docx/SKILL.md': skillMd('needs-docx', 'Create a Word document.'),
    'skills/needs-docx/scripts/make_doc.py': 'import json\nimport docx\nfrom docx.shared import Pt\n\nprint(json.dumps({}))\n',
    'skills/win-script/SKILL.md': skillMd('win-script', 'Run a Windows helper.'),
    'skills/win-script/scripts/run.ps1': 'Write-Output "hi"\n',
    'skills/net-script/SKILL.md': skillMd('net-script', 'Look something up.'),
    'skills/net-script/scripts/lookup.py': 'import requests\n\nr = requests.get("https://api.example.com/data")\nprint(r.text)\n',
    'skills/html-ext/SKILL.md': skillMd('html-ext', 'Render a chart page.'),
    'skills/html-ext/assets/view.html': '<!doctype html>\n<html><head><script src="https://cdn.example.com/chart.js"></script></head><body></body></html>\n',
    'skills/linked/SKILL.md': skillMd('linked', 'Uses a shared reference.', 'Read ref.md first.\n'),
    'skills/input-var/SKILL.md': skillMd('input-var', 'Write a spec.', 'Use ${input:purpose} as the purpose and save to docs/spec.md.\n'),
    'skills/persona/SKILL.md': skillMd('persona', 'Analyze a meeting and build persona profiles of the participants, including power dynamics.'),
    // Would leave a marker if anything ran it (node --test discovers test-*.cjs on its own; .cjs so it runs under any package scope).
    'skills/js-helper/SKILL.md': skillMd('js-helper', 'Browser helper.'),
    'skills/js-helper/scripts/test-helper.cjs': "require('fs').writeFileSync(require('path').join(__dirname, 'EXECUTED'), '1')\n",
    'skills/folded/SKILL.md': '---\nname: folded\ndescription: >\n  Review a change request\n  for risks.\nmetadata:\n  version: "1.0"\n---\n\n# folded\n\nReview it.\n',
  }, [{ path: 'skills/linked/ref.md', target: '../../outside.md' }])
  const apacheUrl = makeRepo('apache-repo', {
    LICENSE: APACHE,
    'skills/own-proprietary/SKILL.md': skillMd('own-proprietary', 'Make a slide deck.'),
    'skills/own-proprietary/LICENSE.txt': PROPRIETARY,
    'skills/apache-ok/SKILL.md': skillMd('apache-ok', 'Draft a status report.'),
  })
  const bareUrl = makeRepo('bare', {
    'skills/no-license/SKILL.md': skillMd('no-license', 'Write release notes.'),
  })
  writeFileSync(SOURCES, JSON.stringify({
    sources: [
      { repo: 'acme/fake-skills', globs: ['skills/*'], note: 'テスト用', url: mitUrl },
      { repo: 'acme/apache-repo', globs: ['skills/*'], note: 'テスト用', url: apacheUrl },
      { repo: 'acme/bare', globs: ['skills/*'], note: 'テスト用', url: bareUrl },
    ],
  }))
  const f = scout(['fetch'])
  assert.equal(f.status, 0, f.stderr + f.stdout)
  const s = scout(['scan', '--keyword', 'meeting report'])
  assert.equal(s.status, 0, s.stderr + s.stdout)
  report = JSON.parse(readFileSync(join(WORK, 'report.json'), 'utf8'))
})

test('fetch: sparse clone without symlinks, with the special entries recorded', () => {
  const meta = JSON.parse(readFileSync(join(WORK, 'cache', 'fake-skills.scout.json'), 'utf8'))
  assert.match(meta.commit, /^[0-9a-f]{40}$/)
  assert.deepEqual(meta.special.filter((e) => e.mode === '120000').map((e) => e.path), ['skills/linked/ref.md'])
  // core.symlinks=false: the link is a plain file holding its target, never a link on disk.
  const p = join(WORK, 'cache', 'node_modules', 'fake-skills', 'skills', 'linked', 'ref.md')
  assert.equal(readFileSync(p, 'utf8'), '../../outside.md')
  assert.ok(existsSync(join(WORK, 'cache', 'node_modules', 'fake-skills', 'LICENSE')))
})

test('fetch: test runners that discover files on their own do not pick up the clones', () => {
  const helper = join(WORK, 'cache', 'node_modules', 'fake-skills', 'skills', 'js-helper', 'scripts')
  assert.ok(existsSync(join(helper, 'test-helper.cjs')))
  // Without NODE_TEST_CONTEXT, which makes a nested node --test skip running files.
  const { NODE_TEST_CONTEXT, ...env } = process.env
  const r = spawnSync(process.execPath, ['--test'], { cwd: WORK, encoding: 'utf8', env })
  assert.doesNotMatch(r.stdout + r.stderr, /called recursively/)
  assert.ok(!existsSync(join(helper, 'EXECUTED')), 'node --test ran a file from an upstream clone')
  assert.equal(rec('skills/js-helper').verdict, '要確認')
})

test('scan: report header says it is a machine pre-screen that a person must follow up', () => {
  const md = readFileSync(join(WORK, 'report.md'), 'utf8')
  assert.match(md, /機械による下調べ/)
  assert.match(md, /人が全文読んで/)
  assert.match(md, /\| 判定 \| スキル \|/)
  assert.equal(report.skills.length, 13)
  // Rows are sorted by verdict.
  const order = ['候補', '要書き換え', '要確認', '不可']
  const idx = report.skills.map((s) => order.indexOf(s.verdict))
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b))
})

test('scan: MIT skill with only text is 候補; gallery README is droppable', () => {
  const r = rec('skills/ok-skill')
  assert.equal(r.verdict, '候補', msgs(r))
  assert.equal(r.license.id, 'MIT')
  assert.match(msgs(r, 'info'), /README\.md はギャラリー用/)
  assert.ok(!r.plan.files.includes('README.md'))
  assert.ok(r.score > 0, 'keyword "meeting" in the description')
})

test('scan: a skill folder with its own proprietary LICENSE inside an Apache repo is 不可', () => {
  const r = rec('skills/own-proprietary')
  assert.equal(r.verdict, '不可')
  assert.equal(r.license.id, 'restricted')
  assert.ok(msgs(r, 'block').includes('独自の LICENSE.txt(独自・制限付き)があり、リポジトリ全体の LICENSE(Apache-2.0)と違う'), msgs(r))
  assert.equal(rec('skills/apache-ok').verdict, '候補')
  assert.equal(rec('skills/apache-ok').license.id, 'Apache-2.0')
})

test('scan: missing LICENSE is 不可', () => {
  const r = rec('skills/no-license')
  assert.equal(r.verdict, '不可')
  assert.match(msgs(r, 'block'), /LICENSE が見つからない/)
})

test('scan: python-docx import is 要確認 for the probe', () => {
  const r = rec('skills/needs-docx')
  assert.equal(r.verdict, '要確認')
  assert.match(msgs(r, 'review'), /標準ライブラリ以外の Python ライブラリ: docx/)
  assert.doesNotMatch(msgs(r, 'review'), /json/)
})

test('scan: a .ps1 script is 不可', () => {
  const r = rec('skills/win-script')
  assert.equal(r.verdict, '不可')
  assert.match(msgs(r, 'block'), /Windows のスクリプト・実行ファイル.*scripts\/run\.ps1/)
})

test('scan: requests.get in a script is 不可 (network)', () => {
  const r = rec('skills/net-script')
  assert.equal(r.verdict, '不可')
  assert.match(msgs(r, 'block'), /ネットワークを使う: requests/)
})

test('scan: an HTML resource loading an external script is 要確認', () => {
  const r = rec('skills/html-ext')
  assert.equal(r.verdict, '要確認')
  assert.match(msgs(r, 'review'), /assets\/view\.html が外部のスクリプトを読み込む/)
})

test('scan: a symlink entry is reported and kept out of the adopted files', () => {
  const r = rec('skills/linked')
  assert.equal(r.verdict, '要確認')
  assert.match(msgs(r, 'review'), /ref\.md はシンボリック リンク/)
  assert.ok(!r.plan.files.includes('ref.md'))
})

test('scan: ${input:} and docs/ are 要書き換え', () => {
  const r = rec('skills/input-var')
  assert.equal(r.verdict, '要書き換え', msgs(r))
  assert.match(msgs(r, 'rewrite'), /\$\{input:\.\.\.\} の変数/)
  assert.match(msgs(r, 'rewrite'), /docs\/ などへの保存指示/)
})

test('scan: persona profiling is flagged for a person, not rejected', () => {
  const r = rec('skills/persona')
  assert.equal(r.verdict, '要確認')
  assert.match(msgs(r, 'review'), /人物像の推定/)
  assert.match(msgs(r, 'review'), /力関係/)
  assert.match(msgs(r, 'review'), /自動では落とさない/)
})

test('scan: folded description and nested frontmatter are handled by the import', () => {
  const r = rec('skills/folded')
  assert.equal(r.verdict, '候補', msgs(r))
  assert.deepEqual(r.plan.dropFrontmatter, ['metadata'])
  assert.equal(r.description.startsWith('Review a change request for risks.'), true)
})

test('adopt / build: refuses 不可 without --force, refuses TODO, then builds zips that pass the packer', () => {
  const ov = join(WORK, 'overlays.json')
  rmSync(ov, { force: true })
  let r = scout(['adopt', 'win-script'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /「不可」なので追加しません/)
  assert.ok(!existsSync(ov), 'nothing written for a refused adopt')

  r = scout(['adopt', 'ok-skill', 'folded'])
  assert.equal(r.status, 0, r.stderr)
  const cfg = JSON.parse(readFileSync(ov, 'utf8'))
  assert.deepEqual(cfg.common, JSON.parse(readFileSync(join(TP, 'overlays.json'), 'utf8')).common)
  assert.match(cfg.skills[0].trigger_ja, /TODO/)
  assert.match(cfg.skills[0].extra[0], /TODO/)

  r = scout(['build'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /TODO/)
  assert.ok(!existsSync(join(WORK, 'zips')), 'no zips while TODO is left')

  r = scout(['adopt', 'win-script', '--force'])
  assert.equal(r.status, 0, r.stderr)
  const fill = () => {
    const c = JSON.parse(readFileSync(ov, 'utf8'))
    for (const s of c.skills) {
      s.trigger_ja = `日本語での依頼例: 「${s.name} を使って」。`
      s.extra = [`- 結果は ${s.name}.md としてファイルで返す。`]
    }
    writeFileSync(ov, JSON.stringify(c, null, 2))
    return c
  }
  fill()
  r = scout(['build'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /win-script は今のチェックで「不可」/)
  assert.ok(!existsSync(join(WORK, 'zips')))

  const c = JSON.parse(readFileSync(ov, 'utf8'))
  c.skills = c.skills.filter((s) => s.name !== 'win-script')
  writeFileSync(ov, JSON.stringify(c, null, 2))
  r = scout(['build'])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.deepEqual(readdirSync(join(WORK, 'zips')).sort(), ['folded.zip', 'ok-skill.zip'])
  for (const z of ['folded.zip', 'ok-skill.zip']) assert.equal(readFileSync(join(WORK, 'zips', z)).subarray(0, 2).toString('latin1'), 'PK')

  const pkgs = ['folded', 'ok-skill'].map((n) => join(WORK, 'packages', n))
  const p = spawnSync(process.execPath, [PACKER, ...pkgs, '--out', join(TMP, 'repack'), '--json'], { encoding: 'utf8' })
  assert.equal(p.status, 0, p.stdout + p.stderr)
  const folded = readFileSync(join(WORK, 'packages', 'folded', 'SKILL.md'), 'utf8')
  assert.match(folded, /^description: 'Review a change request for risks\. 日本語での依頼例: 「folded を使って」。'$/m)
  assert.doesNotMatch(folded.split('\n---\n')[0], /metadata/)
  assert.ok(folded.includes('\n## 原文\n\n# folded\n\nReview it.\n'))
  const source = readFileSync(join(WORK, 'packages', 'folded', 'SOURCE.md'), 'utf8')
  assert.match(source, /frontmatter から `metadata` を外した/)
  assert.match(source, /複数行の description を 1 行にまとめた/)
  assert.ok(!existsSync(join(WORK, 'packages', 'ok-skill', 'README.md')))
  assert.match(readFileSync(join(WORK, 'packages', 'ok-skill', 'LICENSE.txt'), 'utf8'), /Permission is hereby granted/)
})

test('adopt: an ambiguous or unknown name is refused', () => {
  const r = scout(['adopt', 'does-not-exist'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /見つかりません/)
})

test('import-upstream: refuses a symlink and a missing file without touching existing packages', () => {
  const out = join(TMP, 'import-out')
  mkdirSync(join(out, 'ok-skill'), { recursive: true })
  mkdirSync(join(out, 'linked'), { recursive: true })
  writeFileSync(join(out, 'ok-skill', 'SENTINEL.txt'), 'old')
  writeFileSync(join(out, 'linked', 'SENTINEL.txt'), 'old')
  const common = JSON.parse(readFileSync(join(TP, 'overlays.json'), 'utf8')).common
  const entry = (name, files) => ({ name, repo: 'acme/fake-skills', path: `skills/${name}`, files, trigger_ja: '日本語での依頼例: 「テスト」。', extra: [] })
  const run = (skills) => {
    const ov = join(TMP, 'import-overlays.json')
    writeFileSync(ov, JSON.stringify({ common, skills }))
    return spawnSync(process.execPath, [IMPORTER, '--src', join(WORK, 'cache', 'node_modules'), '--overlays', ov, '--out', out], { encoding: 'utf8' })
  }
  const unchanged = () => {
    assert.equal(readFileSync(join(out, 'ok-skill', 'SENTINEL.txt'), 'utf8'), 'old')
    assert.equal(readFileSync(join(out, 'linked', 'SENTINEL.txt'), 'utf8'), 'old')
    assert.ok(!existsSync(join(out, 'ok-skill', 'SKILL.md')), 'the good skill listed first is not written either')
  }

  let r = run([entry('ok-skill', ['SKILL.md']), entry('linked', ['SKILL.md', 'ref.md'])])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /ref\.md は git 上でシンボリック リンク/)
  unchanged()

  r = run([entry('ok-skill', ['SKILL.md', 'references/missing.md'])])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /上流のファイル references\/missing\.md がありません/)
  unchanged()

  r = run([entry('ok-skill', ['SKILL.md', '../needs-docx/SKILL.md'])])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /パス .* が不正です/)
  unchanged()

  r = run([entry('ok-skill', ['SKILL.md', 'references/guide.md'])])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(join(out, 'ok-skill', 'SKILL.md')))
  assert.ok(!existsSync(join(out, 'ok-skill', 'SENTINEL.txt')), 'a successful import replaces the package')
})

test('import-upstream: refuses a symlink that exists on disk', (t) => {
  const src = join(TMP, 'disk-src')
  const clone = join(src, 'disk-repo')
  mkdirSync(join(clone, 'skills', 'x'), { recursive: true })
  writeFileSync(join(clone, 'LICENSE'), MIT)
  writeFileSync(join(clone, 'skills', 'x', 'SKILL.md'), skillMd('x', 'Test.'))
  git(clone, ['init', '-q'])
  git(clone, ['add', '-A'])
  git(clone, ['commit', '-q', '-m', 'init'])
  try {
    symlinkSync(join(clone, 'LICENSE'), join(clone, 'skills', 'x', 'ref.md'))
  } catch (e) {
    t.skip(`cannot create a symlink here (${e.code})`)
    return
  }
  const ov = join(TMP, 'disk-overlays.json')
  const common = JSON.parse(readFileSync(join(TP, 'overlays.json'), 'utf8')).common
  writeFileSync(ov, JSON.stringify({ common, skills: [{ name: 'x', repo: 'acme/disk-repo', path: 'skills/x', files: ['SKILL.md', 'ref.md'], trigger_ja: '', extra: [] }] }))
  const out = join(TMP, 'disk-out')
  const r = spawnSync(process.execPath, [IMPORTER, '--src', src, '--overlays', ov, '--out', out], { encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /ref\.md はシンボリック リンクなので取り込みません/)
  assert.ok(!existsSync(join(out, 'x')))
})

test('import-upstream: the committed third-party SKILL.md files are what the Node assembly produces', () => {
  const cfg = JSON.parse(readFileSync(join(TP, 'overlays.json'), 'utf8'))
  for (const skill of cfg.skills) {
    const upstream = readFileSync(join(TP, '_upstream', `${skill.name}.SKILL.md`), 'utf8')
    const pkg = readFileSync(join(TP, skill.name, 'SKILL.md'), 'utf8')
    assert.equal(assembleSkillMd(upstream, skill, cfg.common).text, pkg.replace(/\r\n/g, '\n'), skill.name)
  }
})
