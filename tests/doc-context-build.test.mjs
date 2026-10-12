// End-to-end test of the doc-context-build scripts against the fixture site in
// tests/fixtures/doc-site, served by tests/fixtures/doc-site-server.py (bearer token
// required, ETag on every file). The fixture is copied to a temp dir so that a page can be
// edited and deleted to exercise change detection.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKILL = join(ROOT, 'shared', 'skills', 'doc-context-build')
const SCRIPTS = join(SKILL, 'scripts')
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'doc-site')
const SERVER = join(ROOT, 'tests', 'fixtures', 'doc-site-server.py')
const TOKEN = 'test-token'

function findPython() {
  for (const cand of [['python3'], ['python'], ['py', '-3']]) {
    if (spawnSync(cand[0], [...cand.slice(1), '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)']).status === 0) return cand
  }
  return null
}
const PY = findPython()

let work, site, project, out, server, port
const env = (extra = {}) => ({ ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', DOC_SITE_TOKEN: TOKEN, ...extra })
const run = (script, args, extraEnv) =>
  spawnSync(PY[0], [...PY.slice(1), '-I', join(SCRIPTS, script), project, '--out', out, ...args], { encoding: 'utf8', env: env(extraEnv) })
const read = (...p) => readFileSync(join(out, ...p), 'utf8')
const pages = () => readdirSync(join(out, 'cache', 'pages'))

before(async () => {
  if (!PY) return
  work = mkdtempSync(join(tmpdir(), 'docctx-'))
  site = join(work, 'site')
  cpSync(FIXTURE, site, { recursive: true })
  project = join(work, 'project')
  cpSync(join(SKILL, 'example'), project, { recursive: true })
  out = join(work, 'out')
  server = spawn(PY[0], [...PY.slice(1), '-I', SERVER, site, '--token', TOKEN], { env: env() })
  port = await new Promise((resolve, reject) => {
    let buf = ''
    server.stdout.on('data', (d) => { buf += d; const m = buf.match(/READY (\d+)/); if (m) resolve(Number(m[1])) })
    server.on('exit', (c) => reject(new Error('server exited ' + c)))
    setTimeout(() => reject(new Error('server did not start')), 15000)
  })
  const cfg = JSON.parse(readFileSync(join(project, 'docctx.json'), 'utf8'))
  cfg.root_url = `http://127.0.0.1:${port}/docs/`
  writeFileSync(join(project, 'docctx.json'), JSON.stringify(cfg))
  const manifest = readFileSync(join(project, 'manifest.json'), 'utf8').replaceAll('127.0.0.1:8765', `127.0.0.1:${port}`)
  writeFileSync(join(project, 'manifest.json'), manifest)
})

after(() => {
  if (server) server.kill()
  if (work) rmSync(work, { recursive: true, force: true })
})

test('collect: crawls the tree with scope, depth, exclude and non-HTML rules', { skip: !PY && 'python 3.8+ not found' }, () => {
  const r = run('collect.py', [])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const index = JSON.parse(read('cache', 'index.json'))
  const urls = Object.keys(index.pages).map((u) => new URL(u).pathname).sort()
  assert.deepEqual(urls, ['/docs/', '/docs/deep/level1.html', '/docs/deep/level2.html', '/docs/deep/level3.html',
    '/docs/env/setup.html', '/docs/packaging/', '/docs/packaging/naming.html', '/docs/packaging/steps.html'])
  assert.ok(!urls.includes('/docs/deep/level4.html'), 'max_depth=3 stops before level 4')
  assert.ok(!urls.some((u) => u.includes('/archive/')), 'exclude is honoured')
  assert.match(r.stdout, /diagram\.png \(image\/png\)/, 'non-HTML is recorded, not cached')
  assert.match(r.stdout, /https:\/\/example\.com\/external-reference/, 'external link recorded')
  assert.equal(index.last_run.added.length, 8)
  const page = read('cache', 'pages', pages().find((f) => f.startsWith('docs__packaging__steps')))
  assert.match(page, /^source_url: "http:\/\/127\.0\.0\.1:\d+\/docs\/packaging\/steps\.html"$/m)
  assert.match(page, /^retrieved_at: "\d{4}-\d{2}-\d{2}T/m)
  assert.match(page, /^content_hash: "sha256:/m)
  assert.match(page, /^1\. リポジトリのルートで依存関係を入れる。 `npm ci`/m, 'pre inside li stays on the item line')
  const naming = read('cache', 'pages', pages().find((f) => f.startsWith('docs__packaging__naming')))
  assert.match(naming, /^\| name \| 小文字とハイフンのみ \| order-service \|$/m, 'tables become Markdown tables')
  for (const f of pages()) assert.ok(!read('cache', 'pages', f).includes(TOKEN), 'token never written')
  assert.ok(!read('cache', 'index.json').includes(TOKEN))
})

test('collect: without the token the root fetch fails with a clear message', { skip: !PY && 'python 3.8+ not found' }, () => {
  const r = spawnSync(PY[0], [...PY.slice(1), '-I', join(SCRIPTS, 'collect.py'), project, '--out', join(work, 'out-notoken')],
    { encoding: 'utf8', env: { ...env(), DOC_SITE_TOKEN: '' } })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /root_url could not be fetched \(401\)/)
  assert.match(r.stderr, /DOC_SITE_TOKEN/)
})

test('bundle + compose: bundles follow the manifest and the context ends with the contract', { skip: !PY && 'python 3.8+ not found' }, () => {
  let r = run('bundle.py', [])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const packaging = read('bundles', 'packaging.md')
  assert.match(packaging, /^pages: 4$/m)
  assert.equal((packaging.match(/<!-- docctx:page /g) || []).length, 4)
  assert.match(packaging, /docctx:page http:\/\/127\.0\.0\.1:\d+\/docs\/env\/setup\.html/, 'single `pages` entry included')
  assert.match(read('bundles', 'impact.md'), /影響するガイドライン: package-guide/)

  r = run('compose.py', [])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const ctx = read('context', 'package-guide.md')
  assert.match(ctx, /^# コンテキスト: パッケージ作成ガイドライン\(1 \/ 1\)/m)
  const iRules = ctx.indexOf('## 執筆ルール(共通)'), iCat = ctx.indexOf('## 執筆ルール(カテゴリ: dev)'), iOwn = ctx.indexOf('## 執筆ルール(このガイドライン)')
  const iBundle = ctx.indexOf('# 束: パッケージ作成'), iContract = ctx.indexOf('## 出力契約と自己検査')
  assert.ok(iRules > 0 && iRules < iCat && iCat < iOwn && iOwn < iBundle && iBundle < iContract, 'rules, bundle, contract in that order')
  assert.ok(ctx.trimEnd().endsWith('何が不明かが読んで分かる。'), 'contract is the very end')
  assert.ok(!ctx.includes('\n\n\n'), 'no triple blank lines')
  const sources = JSON.parse(read('context', 'package-guide.sources.json'))
  assert.equal(sources.sources.length, 4)
  assert.equal(sources.stale, false)
  assert.ok(!existsSync(join(out, 'context', 'env-setup-guide.part1.md')))
})

test('compose: a small split_chars splits at page boundaries with the contract last', { skip: !PY && 'python 3.8+ not found' }, () => {
  const r = run('compose.py', ['--only', 'package-guide', '--split-chars', '1200'])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const parts = readdirSync(join(out, 'context')).filter((f) => /^package-guide\.part\d+\.md$/.test(f)).sort()
  assert.ok(parts.length >= 3, 'split into several parts: ' + parts.join(','))
  const first = read('context', parts[0]), last = read('context', parts[parts.length - 1])
  assert.match(first, new RegExp(`\\(1 / ${parts.length}\\)`))
  assert.match(first, /すべてを 1 回のメッセージに添付/)
  assert.ok(first.includes('## 執筆ルール(共通)') && !first.includes('## 出力契約と自己検査'))
  assert.ok(last.includes('## 出力契約と自己検査') && !last.includes('## 執筆ルール(共通)'))
  for (const p of parts.slice(1)) assert.match(read('context', p), /^<!-- 元ページ(\(続き\))?: /m, 'later parts start at a page boundary')
  const sources = JSON.parse(read('context', 'package-guide.sources.json'))
  assert.deepEqual(sources.parts, parts)
})

test('collect again: unchanged cache, then a changed and a removed page are detected', { skip: !PY && 'python 3.8+ not found' }, () => {
  let r = run('collect.py', ['--dry-run'])
  assert.equal(r.status, 0, 'dry-run exit 0 when current: ' + r.stdout)
  assert.match(r.stdout, /cache is current/)

  const naming = join(site, 'docs', 'packaging', 'naming.html')
  writeFileSync(naming, readFileSync(naming, 'utf8').replace('-rc.1', '-beta.1'))
  rmSync(join(site, 'docs', 'deep', 'level3.html'))
  r = run('collect.py', ['--dry-run'])
  assert.equal(r.status, 3, 'dry-run exit 3 when the site differs')
  assert.match(r.stdout, /changes detected/)
  assert.ok(!existsSync(join(out, 'cache', '_removed')), 'dry-run writes nothing')

  r = run('collect.py', [])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const index = JSON.parse(read('cache', 'index.json'))
  assert.deepEqual(index.last_run.changed.map((u) => new URL(u).pathname), ['/docs/packaging/naming.html'])
  assert.deepEqual(index.last_run.removed.map((u) => new URL(u).pathname), ['/docs/deep/level3.html'])
  assert.equal(index.last_run.added.length, 0)
  assert.ok(readdirSync(join(out, 'cache', '_removed')).some((f) => f.startsWith('docs__deep__level3')))
  assert.match(read('cache', 'changes.md'), /変更 1 \/ 不変 6 \/ 削除 1/)

  r = run('bundle.py', [])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const impact = read('bundles', 'impact.md')
  assert.match(impact, /## 束 packaging/)
  assert.match(impact, /naming\.html \(changed\)/)
  assert.ok(!impact.includes('## 束 environment'), 'untouched bundle is not listed')
})

test('compose --strict: a stale bundle is skipped', { skip: !PY && 'python 3.8+ not found' }, () => {
  const bundle = join(out, 'bundles', 'environment.md')
  writeFileSync(bundle, readFileSync(bundle, 'utf8').replace(/^oldest_retrieved_at: .*$/m, 'oldest_retrieved_at: 2020-01-01T00:00:00Z'))
  let r = run('compose.py', ['--only', 'env-setup-guide'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /warning: env-setup-guide - 束の最も古いページは \d+ 日前/)
  assert.match(read('context', 'env-setup-guide.md'), /\*\*注意: 束の最も古いページは/)
  r = run('compose.py', ['--only', 'env-setup-guide', '--strict'])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /strict: skipping env-setup-guide/)
})
