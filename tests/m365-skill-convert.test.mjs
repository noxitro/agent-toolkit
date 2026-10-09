// Tests for the skill converter (shared/skills/m365-skill-convert/scripts/skill2zip.mjs).
// No network: local folders are made in a temp directory, installed skills under a fake
// HOME, and GitHub input is served from a `git init` repository through file:// by
// pointing SKILL2ZIP_GITHUB_BASE at it. Every run checks that the source folder is
// byte-for-byte unchanged afterwards.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readZip } from '../shared/skills/m365-skill-pack/scripts/lib/unzip.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKILL = join(ROOT, 'shared/skills/m365-skill-convert')
const CLI = join(SKILL, 'scripts/skill2zip.mjs')
const PACKER = join(ROOT, 'shared/skills/m365-skill-pack/scripts/pack-skill.mjs')
const TMP = mkdtempSync(join(tmpdir(), 'm365-convert-'))
after(() => rmSync(TMP, { recursive: true, force: true }))

const MIT = 'MIT License\n\nCopyright (c) 2026 Example\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software...\n'
const PROPRIETARY = '(c) 2026 Example Corp. All rights reserved.\n\nADDITIONAL RESTRICTIONS: users may not reproduce, distribute or create derivative works.\n'
const skillMd = (name, description, body = 'Do the task step by step.\n', extraFm = '') => `---\nname: ${name}\ndescription: ${description}\n${extraFm}---\n\n# ${name}\n\n${body}`

let n = 0
/** A folder with the given files under TMP; returns its path. */
function folder(files, name = `case${++n}`) {
  const dir = join(TMP, 'src', name)
  for (const [rel, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), data)
  }
  return dir
}

function hashTree(dir) {
  const h = createHash('sha256')
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(d, e.name)
      h.update(relative(dir, abs).split(sep).join('/') + '\0')
      if (e.isDirectory()) walk(abs)
      else h.update(readFileSync(abs))
    }
  }
  walk(dir)
  return h.digest('hex')
}

/** Run the converter with a fresh output folder; asserts the source is unchanged when given. */
function run(args, { src = null, env = {}, cwd = TMP, out = join(TMP, 'out', `run${++n}`) } = {}) {
  const before = src ? hashTree(src) : null
  const r = spawnSync(process.execPath, [CLI, ...args, '--out', out], { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
  if (src) assert.equal(hashTree(src), before, `source folder changed: ${src}`)
  r.out = out
  r.all = r.stdout + r.stderr
  return r
}

const report = (r, name) => readFileSync(join(r.out, `${name}.report.md`), 'utf8')
const zipEntries = (path) => Object.fromEntries(readZip(readFileSync(path)).map((e) => [e.name, e.data.toString('utf8')]))

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

// ------------------------------------------------------------------ local input

test('own local skill: no overlay, zip passes the packer and equals pack-skill.mjs byte for byte', () => {
  const src = folder({ 'SKILL.md': skillMd('own-notes', 'Summarise meeting notes into decisions.'), 'LICENSE.txt': MIT, 'references/guide.md': '# Guide\n' })
  const r = run([src], { src })
  assert.equal(r.status, 0, r.all)
  const zip = join(r.out, 'own-notes.zip')
  const entries = zipEntries(zip)
  assert.deepEqual(Object.keys(entries).sort(), ['LICENSE.txt', 'SKILL.md', 'references/guide.md'])
  assert.doesNotMatch(entries['SKILL.md'], /原文|読み替え/)
  assert.ok(!('SOURCE.md' in entries), 'no SOURCE.md for an own skill')
  assert.match(report(r, 'own-notes'), /機械による下調べ/)
  assert.match(report(r, 'own-notes'), /自作のスキル/)

  // The staged copy is what went into the zip; the m365-skill-pack packer produces the same bytes.
  const staged = join(r.out, 'node_modules', 'own-notes')
  const p = spawnSync(process.execPath, [PACKER, staged, '--out', join(TMP, 'repack'), '--json'], { encoding: 'utf8' })
  assert.equal(p.status, 0, p.stdout + p.stderr)
  assert.ok(readFileSync(join(TMP, 'repack', 'own-notes.zip')).equals(readFileSync(zip)), 'zip differs from pack-skill.mjs output')
})

test('own skill without a license stops, --allow-license-unknown continues, and is refused for third-party', () => {
  const src = folder({ 'SKILL.md': skillMd('no-lic', 'Write release notes.') })
  let r = run([src], { src })
  assert.equal(r.status, 1, r.all)
  assert.match(r.stderr, /LICENSE が見つからない/)
  assert.match(report(r, 'no-lic'), /--allow-license-unknown/)
  assert.ok(!existsSync(join(r.out, 'no-lic.zip')))

  r = run([src, '--allow-license-unknown'], { src })
  assert.equal(r.status, 0, r.all)
  assert.ok(existsSync(join(r.out, 'no-lic.zip')))

  r = run([src, '--allow-license-unknown', '--origin', 'third-party'], { src })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /自作のスキル/)
})

test('third-party folder: LICENSE renamed, gallery files dropped, BOM/CRLF and frontmatter fixed, LICENSE.txt and SOURCE.md in the zip', () => {
  const src = folder({
    'SKILL.md': '﻿' + skillMd('gallery-skill', 'Draft a status report.', 'Write the report.\r\nKeep it short.\r\n', 'license: MIT\nmetadata:\n  version: "1.0"\n').replace(/\n/g, '\r\n'),
    LICENSE: MIT,
    'README.md': '# Gallery readme\n',
    'metadata.json': '{"stars": 5}\n',
    '.github/workflows/ci.yml': 'on: push\n',
    'references/notes.md': 'line\r\n',
  })
  const overlayFile = join(TMP, 'gallery.overlay.json')
  writeFileSync(overlayFile, JSON.stringify({ trigger_ja: '日本語での依頼例: 「状況報告を書いて」。', extra: ['- 結果は status.md としてファイルで返す。'] }))
  const r = run([src, '--origin', 'third-party', '--overlay-file', overlayFile], { src })
  assert.equal(r.status, 0, r.all)
  const md = report(r, 'gallery-skill')
  assert.match(md, /拡張子の無いライセンス ファイルに \.txt を付けた: `LICENSE → LICENSE\.txt`/)
  assert.match(md, /ギャラリー用の付属ファイルを外した.*`README\.md`.*`metadata\.json`/)
  assert.match(md, /ドットファイル・ドットフォルダを外した.*`\.github\/`/)
  assert.match(md, /UTF-8 の BOM を外した: `SKILL\.md`/)
  assert.match(md, /改行を CRLF から LF にした: .*`references\/notes\.md`/)
  assert.match(md, /frontmatter から `license`, `metadata` を外した/)

  const entries = zipEntries(join(r.out, 'gallery-skill.zip'))
  assert.deepEqual(Object.keys(entries).sort(), ['LICENSE.txt', 'SKILL.md', 'SOURCE.md', 'references/notes.md'])
  assert.match(entries['LICENSE.txt'], /Permission is hereby granted/)
  assert.match(entries['SOURCE.md'], /^# 出典/)
  assert.match(entries['SOURCE.md'], /README\.md/)
  assert.doesNotMatch(entries['SOURCE.md'], /[A-Za-z]:[\\/]|\/Users\/|\/home\//, 'no absolute local path in SOURCE.md')
  const skill = entries['SKILL.md']
  assert.match(skill, /^---\nname: gallery-skill\ndescription: 'Draft a status report\. 日本語での依頼例: 「状況報告を書いて」。'\n---\n/)
  assert.ok(skill.includes('## Microsoft 365 Copilot で使うときの読み替え'))
  assert.ok(skill.includes('- 結果は status.md としてファイルで返す。'))
  assert.ok(skill.includes('\n## 原文\n\n# gallery-skill\n\nWrite the report.\nKeep it short.\n'))
  assert.ok(!skill.includes('\r'))
})

test('overlay TODO blocks the zip unless --draft, and the template lists the harness findings', () => {
  const src = folder({ 'SKILL.md': skillMd('spec-writer', 'Write a spec.', 'Use ${input:purpose} and post it to Slack.\n'), 'LICENSE.txt': MIT })
  const out = join(TMP, 'out', 'todo')
  let r = run([src, '--origin', 'third-party'], { src, out })
  assert.equal(r.status, 1, r.all)
  assert.match(r.stderr, /TODO が残っている/)
  assert.ok(!existsSync(join(out, 'spec-writer.zip')) && !existsSync(join(out, 'spec-writer.draft.zip')))
  const tpl = JSON.parse(readFileSync(join(out, 'spec-writer.overlay.json'), 'utf8'))
  assert.match(tpl.trigger_ja, /TODO/)
  assert.ok(tpl.extra.some((l) => /TODO: \$\{input:\.\.\.\} の変数/.test(l)), tpl.extra.join('\n'))
  assert.ok(tpl.extra.some((l) => /TODO: Slack/.test(l)), tpl.extra.join('\n'))

  r = run([src, '--origin', 'third-party', '--draft'], { src, out })
  assert.equal(r.status, 0, r.all)
  assert.ok(existsSync(join(out, 'spec-writer.draft.zip')))
  assert.ok(!existsSync(join(out, 'spec-writer.zip')), 'a draft never gets the plain name')
  assert.match(report(r, 'spec-writer'), /下書きの ZIP/)

  // Filled in: the plain zip is written.
  writeFileSync(join(out, 'spec-writer.overlay.json'), JSON.stringify({ trigger_ja: '日本語での依頼例: 「仕様書を書いて」。', extra: ['- 目的はメッセージから取る。Slack には投稿せず、ファイルで返す。'] }))
  r = run([src, '--origin', 'third-party'], { src, out })
  assert.equal(r.status, 0, r.all)
  assert.ok(existsSync(join(out, 'spec-writer.zip')))
  assert.ok(!existsSync(join(out, 'spec-writer.draft.zip')), 'the stale draft from the earlier run is removed')
  assert.match(report(r, 'spec-writer'), /spec-writer.draft.zip` は、このレポートと合わないので消した/)
})

test('a Windows script blocks; --force leaves it out and records why', () => {
  const src = folder({ 'SKILL.md': skillMd('win-helper', 'Run a helper.'), 'LICENSE.txt': MIT, 'scripts/run.ps1': 'Write-Output "hi"\n' })
  let r = run([src], { src })
  assert.equal(r.status, 1, r.all)
  assert.match(r.stderr, /Windows のスクリプト・実行ファイル/)
  assert.ok(!existsSync(join(r.out, 'win-helper.zip')))

  r = run([src, '--force'], { src })
  assert.equal(r.status, 0, r.all)
  const entries = zipEntries(join(r.out, 'win-helper.zip'))
  assert.ok(!('scripts/run.ps1' in entries))
  assert.match(report(r, 'win-helper'), /--force で通した項目[\s\S]*Windows のスクリプト[\s\S]*--force の指定で外した.*scripts\/run\.ps1/)
})

test('a restrictive license blocks', () => {
  const src = folder({ 'SKILL.md': skillMd('closed', 'Make a slide deck.'), 'LICENSE.txt': PROPRIETARY })
  const r = run([src, '--origin', 'third-party', '--draft'], { src })
  assert.equal(r.status, 1, r.all)
  assert.match(r.stderr, /独自・制限付き/)
  assert.ok(!readdirSync(r.out).some((f) => f.endsWith('.zip')))
})

test('Claude-only features block: allowed-tools in the frontmatter, subagents in the text', () => {
  const src = folder({ 'SKILL.md': skillMd('claude-only', 'Review code.', 'Spawn a subagent for each file.\n', 'allowed-tools: Read, Grep\n'), 'LICENSE.txt': MIT })
  const r = run([src], { src })
  assert.equal(r.status, 1, r.all)
  assert.match(r.stderr, /frontmatter の allowed-tools/)
  assert.match(r.stderr, /Claude Code 専用の機能: サブエージェント/)
})

test('own skill with a folded description: flattened to one line and recorded', () => {
  const src = folder({ 'SKILL.md': '---\nname: folded\ndescription: >\n  Review a change request\n  for risks.\n---\n\n# folded\n\nReview it.\n', 'LICENSE.txt': MIT })
  const r = run([src], { src })
  assert.equal(r.status, 0, r.all)
  const skill = zipEntries(join(r.out, 'folded.zip'))['SKILL.md']
  assert.equal(skill, "---\nname: folded\ndescription: 'Review a change request for risks.'\n---\n\n# folded\n\nReview it.\n")
  assert.match(report(r, 'folded'), /複数行の description を 1 行にまとめた/)
})

test('SKILL.md below the folder root is an error that names where it is', () => {
  const src = folder({ 'skills/inner/SKILL.md': skillMd('inner', 'Inner.'), LICENSE: MIT })
  const r = run([src], { src })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /直下に SKILL\.md がありません.*skills\/inner\/SKILL\.md/)
})

test('an output folder inside the source folder is refused', () => {
  const src = folder({ 'SKILL.md': skillMd('inside', 'Inside.'), 'LICENSE.txt': MIT })
  const r = run([src], { src, out: join(src, 'm365-zips') })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /重なります/)
  assert.ok(!existsSync(join(src, 'm365-zips')))
})

// ------------------------------------------------------------------ installed skills

test('installed skill: found by name under a fake HOME; an ambiguous name lists every match', () => {
  const home = join(TMP, 'home')
  const work = join(TMP, 'work')
  mkdirSync(work, { recursive: true })
  const one = join(home, '.claude', 'skills', 'solo')
  folder({ 'SKILL.md': skillMd('solo', 'Solo skill.'), 'LICENSE.txt': MIT }, '../home/.claude/skills/solo')
  const env = { HOME: home, USERPROFILE: home }
  let r = run(['solo'], { src: one, env, cwd: work })
  assert.equal(r.status, 0, r.all)
  assert.match(report(r, 'solo'), /インストール済みのスキル/)
  assert.ok(report(r, 'solo').includes('Claude Code(ユーザー)'))

  folder({ 'SKILL.md': skillMd('twin', 'Twin A.'), 'LICENSE.txt': MIT }, '../home/.claude/skills/twin')
  folder({ 'SKILL.md': skillMd('twin', 'Twin B.'), 'LICENSE.txt': MIT }, '../home/.copilot/skills/twin')
  folder({ 'SKILL.md': skillMd('twin', 'Twin C.'), 'LICENSE.txt': MIT }, '../work/.github/skills/twin')
  r = run(['twin'], { env, cwd: work })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /3 か所にあります/)
  for (const p of [join(home, '.claude', 'skills', 'twin'), join(home, '.copilot', 'skills', 'twin'), join(work, '.github', 'skills', 'twin')]) {
    assert.ok(r.stderr.toLowerCase().includes(resolve(p).toLowerCase()), `missing ${p} in:\n${r.stderr}`)
  }

  r = run(['nothing-here'], { env, cwd: work })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /見つかりません/)
})

// ------------------------------------------------------------------ GitHub input

test('GitHub input via a file:// fake repository: draft zip with LICENSE.txt and SOURCE.md; a symlink entry is refused', () => {
  const base = join(TMP, 'gh')
  const repo = join(base, 'acme', 'skills')
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q'])
  const files = {
    LICENSE: MIT,
    'skills/good/SKILL.md': skillMd('good', 'Summarise an incident.'),
    'skills/good/references/how.md': '# How\n',
    'skills/linked/SKILL.md': skillMd('linked', 'Uses a shared file.'),
  }
  for (const [rel, data] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true })
    writeFileSync(join(repo, rel), data)
  }
  git(repo, ['add', '-A'])
  // A symlink recorded in the index without creating one on disk (no privilege needed).
  const sha = git(repo, ['hash-object', '-w', '--stdin'], '../../LICENSE')
  git(repo, ['update-index', '--add', '--cacheinfo', `120000,${sha},skills/linked/ref.md`])
  git(repo, ['commit', '-q', '-m', 'init'])
  git(repo, ['checkout', '-q', '-b', 'feature/x'])
  const commit = git(repo, ['rev-parse', 'HEAD'])
  const env = { SKILL2ZIP_GITHUB_BASE: pathToFileURL(base).href }
  const temps = () => readdirSync(tmpdir()).filter((f) => f.startsWith('skill2zip-')).length
  const before = temps()

  let r = run(['https://github.com/acme/skills/tree/main/skills/good', '--draft'], { env })
  assert.equal(r.status, 0, r.all)
  const entries = zipEntries(join(r.out, 'good.draft.zip'))
  assert.deepEqual(Object.keys(entries).sort(), ['LICENSE.txt', 'SKILL.md', 'SOURCE.md', 'references/how.md'])
  assert.match(entries['SOURCE.md'], new RegExp(`https://github\\.com/acme/skills/tree/${commit}/skills/good`))
  assert.match(entries['SOURCE.md'], /元の `LICENSE` をそのまま同梱/)
  assert.ok(entries['SKILL.md'].includes('## 原文'), 'third-party input gets the overlay by default')
  assert.match(report(r, 'good'), /第三者のスキル/)
  // Checked before LICENSE.txt is added: the license found is the repository's, not the added copy.
  assert.ok(report(r, 'good').includes('[参考] ライセンス: MIT(LICENSE)'), report(r, 'good'))
  assert.doesNotMatch(report(r, 'good'), /スキルのフォルダにも/)
  assert.equal(temps(), before, 'the temp clone is removed')

  // A branch name with a slash, and the blob form of the URL.
  r = run(['https://github.com/acme/skills/blob/feature/x/skills/good/SKILL.md', '--draft'], { env })
  assert.equal(r.status, 0, r.all)
  assert.match(report(r, 'good'), /tree\/feature\/x\/skills\/good/)

  r = run(['https://github.com/acme/skills/tree/main/skills/linked', '--draft'], { env })
  assert.equal(r.status, 2, r.all)
  assert.match(r.stderr, /シンボリック リンク.*ref\.md/)
  assert.ok(!existsSync(join(r.out, 'linked.draft.zip')))

  r = run(['https://github.com/acme/skills/tree/no-such-branch/skills/good'], { env })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /ブランチまたはタグ no-such-branch がリポジトリにありません/)
  assert.equal(temps(), before)
})

// ------------------------------------------------------------------ single source

test('the vendored packer files are byte-identical to m365-skill-pack', () => {
  for (const f of ['m365-rules.mjs', 'zip.mjs', 'args.mjs']) {
    const a = readFileSync(join(SKILL, 'scripts/lib', f))
    const b = readFileSync(join(ROOT, 'shared/skills/m365-skill-pack/scripts/lib', f))
    assert.ok(a.equals(b), `${f} drifted from m365-skill-pack; copy it again`)
  }
})

test('the default 読み替え text equals the one the committed third-party packages were built with', () => {
  const a = JSON.parse(readFileSync(join(SKILL, 'scripts/lib/overlay-ja.json'), 'utf8')).common
  const b = JSON.parse(readFileSync(join(ROOT, 'm365-org-skills/third-party/overlays.json'), 'utf8')).common
  assert.deepEqual(a, b)
})

test('the skill folder is self-contained: no import leaves it', () => {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]))
  for (const file of walk(SKILL).filter((f) => f.endsWith('.mjs'))) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
      const spec = m[1]
      if (spec.startsWith('node:')) continue
      assert.ok(spec.startsWith('.'), `${file}: bare import ${spec} (no node_modules next to an installed skill)`)
      const target = resolve(dirname(file), spec)
      assert.ok(!relative(SKILL, target).startsWith('..'), `${file}: ${spec} points outside the skill folder`)
      assert.ok(existsSync(target) && statSync(target).isFile(), `${file}: ${spec} does not exist`)
    }
  }
})
