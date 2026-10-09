#!/usr/bin/env node
// Skill scout: collect public SKILL.md skills, pre-screen them by machine, and package the
// ones a person approves as Microsoft 365 Copilot (Agent Builder) skill zips.
//
//   node scout.mjs fetch    [--source <owner/repo>]       safe sparse shallow clone / update
//   node scout.mjs scan     [--keyword "<words>"]        checks -> report.md / report.json
//   node scout.mjs adopt    <name|ID>... [--as <name>] [--force]
//   node scout.mjs build    [--force]                     import + pack -> zips/
//   node scout.mjs discover [--topic <topic>]...          GitHub search for more sources (prints only)
//
// Common options: --dir <work dir> (default <repo>/artifacts/skill-scout), --sources <file>,
// --checks <file>, --overlays <file>. Needs Node 20+ and git; nothing from a cloned
// repository is ever executed.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from '../../shared/skills/m365-skill-pack/scripts/lib/args.mjs'
import { LIMITS } from '../../shared/skills/m365-skill-pack/scripts/lib/m365-rules.mjs'
import { ImportError, importUpstream } from './import-upstream.mjs'
import { LEVEL_LABEL, analyzeSkill, findSkillDirs, loadChecks } from '../../shared/skills/m365-skill-convert/scripts/lib/checks.mjs'
import { GitError, MODE_LABEL } from '../../shared/skills/m365-skill-convert/scripts/lib/git.mjs'
import { TODO_EXTRA, TODO_TRIGGER, defaultCommon, harnessTodoLines, hasTodo } from '../../shared/skills/m365-skill-convert/scripts/lib/overlay.mjs'
import { renderReport, sortRecords } from './lib/report.mjs'
import { ConfigError, cloneDir, clonesDir, fetchSource, loadSources, readJson, readMeta } from './lib/sources.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
// The checks, the safe clone and the overlay assembly are shared with the skill converter
// and live in its skill folder (one copy).
const CONVERT_LIB = join(REPO, 'shared', 'skills', 'm365-skill-convert', 'scripts', 'lib')
const PACKER = join(REPO, 'shared', 'skills', 'm365-skill-pack', 'scripts', 'pack-skill.mjs')
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/
const SELF = 'node m365-org-skills/scout/scout.mjs'

const HELP = `
スキル スカウト: 公開されている SKILL.md 形式のスキルを集めて機械でチェックし、
人が選んだものを Microsoft 365 Copilot(Agent Builder)のスキル ZIP にする。

使い方:
  ${SELF} fetch    [--source <owner/repo>]
      sources.json のリポジトリを安全に取得・更新する(浅い・部分的な clone。中身は実行しない)
  ${SELF} scan     [--keyword "<語> <語>..."] [--source <owner/repo>]
      全スキルをチェックし、report.md と report.json を書く
  ${SELF} adopt    <名前またはID>... [--as <名前>] [--force]
      選んだスキルを自分用の overlays.json に追加する(「不可」は --force が無いと追加しない)
  ${SELF} build    [--force]
      overlays.json の TODO が埋まっていれば、取り込んで ZIP を作る
  ${SELF} discover [--topic <トピック>]...
      GitHub で候補のリポジトリを探して表示する(sources.json には自動で足さない)

共通のオプション:
  --dir <フォルダ>       作業フォルダ(既定: <リポジトリ>/artifacts/skill-scout)
  --sources <ファイル>   取得元の一覧(既定: m365-org-skills/scout/sources.json)
  --checks <ファイル>    チェックの語句(既定: shared/skills/m365-skill-convert/scripts/lib/checks.json)
  --overlays <ファイル>  自分用の取り込み定義(既定: <作業フォルダ>/overlays.json)

作業フォルダの中身: cache/node_modules/(取得したリポジトリ) report.md report.json overlays.json
                    packages/(取り込んだスキル) zips/(Agent Builder に追加する ZIP)

レポートは機械による下調べ。採用するスキルは、SKILL.md と同梱するすべてのファイルを
人が全文読んでから使うこと。
`

class UserError extends Error {}

function paths(opts) {
  const dir = resolve(opts.dir ?? join(REPO, 'artifacts', 'skill-scout'))
  return {
    dir,
    cache: join(dir, 'cache'),
    reportMd: join(dir, 'report.md'),
    reportJson: join(dir, 'report.json'),
    overlays: resolve(opts.overlays ?? join(dir, 'overlays.json')),
    packages: join(dir, 'packages'),
    zips: join(dir, 'zips'),
    sources: resolve(opts.sources ?? join(HERE, 'sources.json')),
    checks: resolve(opts.checks ?? join(CONVERT_LIB, 'checks.json')),
  }
}

function selectSources(all, only) {
  if (!only) return all
  const s = all.filter((x) => x.repo.toLowerCase() === only.toLowerCase())
  if (!s.length) throw new UserError(`--source ${only} は sources.json にありません(${all.map((x) => x.repo).join(', ')})`)
  return s
}

const common = () => defaultCommon()

// --------------------------------------------------------------------- fetch

function cmdFetch(opts) {
  const p = paths(opts)
  const sources = selectSources(loadSources(p.sources), opts.source)
  let failed = 0
  for (const s of sources) {
    try {
      const meta = fetchSource(p.cache, s, (m) => console.log(m))
      const clone = cloneDir(p.cache, s.repo)
      const n = findSkillDirs(clone, s.globs).length
      const counts = {}
      for (const e of meta.special) counts[e.mode] = (counts[e.mode] ?? 0) + 1
      const special = Object.entries(counts).map(([m, c]) => `${MODE_LABEL[m]} ${c} 個`).join('、')
      console.log(`  -> コミット ${meta.commit.slice(0, 12)}(${meta.date})、スキル ${n} 個${special ? `。注意が要るエントリ: ${special}(scan で該当スキルに表示)` : ''}`)
    } catch (e) {
      if (!(e instanceof GitError || e instanceof ConfigError)) throw e
      failed++
      console.error(`  エラー: ${s.repo}: ${e.message}`)
    }
  }
  if (failed) {
    console.error(`\n${failed} 件の取得に失敗しました。ネットワークとプロキシの設定を確認してください。`)
    return 1
  }
  console.log(`\n取得先: ${clonesDir(p.cache)}`)
  return 0
}

// ---------------------------------------------------------------------- scan

function analyzeAll(p, sourcesSel, keywords = []) {
  const checks = loadChecks(p.checks)
  const cmn = common()
  const records = []
  const used = []
  for (const s of sourcesSel) {
    const meta = readMeta(p.cache, s)
    const clone = cloneDir(p.cache, s.repo)
    used.push({ ...s, meta })
    if (!meta || !existsSync(clone)) {
      console.error(`注意: ${s.repo} はまだ取得していません(先に fetch を実行)`)
      continue
    }
    for (const rel of findSkillDirs(clone, s.globs)) records.push(analyzeSkill({ clone, skillRel: rel, source: s, meta, checks, common: cmn, keywords }))
  }
  return { records, used }
}

function splitKeywords(s) {
  return (s ?? '').toLowerCase().split(/[\s,、]+/).filter(Boolean)
}

function cmdScan(opts) {
  const p = paths(opts)
  const sources = selectSources(loadSources(p.sources), opts.source)
  const keywords = splitKeywords(opts.keyword)
  const { records, used } = analyzeAll(p, sources, keywords)
  if (!records.length) throw new UserError('チェックするスキルがありません。先に fetch を実行してください')
  const generatedAt = new Date().toLocaleString('ja-JP', { hour12: false })
  mkdirSync(p.dir, { recursive: true })
  writeFileSync(p.reportMd, renderReport({ records, sources: used, keywords, generatedAt, overlaysCmd: `${SELF} adopt` }))
  const json = {
    note: 'Machine pre-screen only. A person must read every adopted SKILL.md and resource in full before use.',
    generatedAt: new Date().toISOString(),
    keywords,
    sources: used.map((s) => ({ repo: s.repo, commit: s.meta?.commit ?? null, date: s.meta?.date ?? null })),
    skills: sortRecords(records),
  }
  writeFileSync(p.reportJson, JSON.stringify(json, null, 2) + '\n')
  const count = (v) => records.filter((r) => r.verdict === v).length
  console.log(`${records.length} 個のスキルをチェックしました: 候補 ${count('候補')}、要書き換え ${count('要書き換え')}、要確認 ${count('要確認')}、不可 ${count('不可')}`)
  console.log(`レポート: ${p.reportMd}`)
  console.log('これは機械による下調べです。採用するスキルは、SKILL.md と同梱ファイルを人が全文読んでから使ってください。')
  return 0
}

// --------------------------------------------------------------------- adopt

function loadOverlays(file) {
  if (!existsSync(file)) return null
  const cfg = readJson(file, 'overlays.json')
  if (!Array.isArray(cfg.common) || !Array.isArray(cfg.skills)) throw new UserError(`${file}: common と skills の配列が要ります`)
  return cfg
}

function newOverlays() {
  return {
    _comment: [
      'Per-user overlays for scout.mjs build. Fill in every TODO before building.',
      'trigger_ja: Japanese request examples appended to the description. extra: lines added under 「このスキルでの読み替え」.',
      'files / license / drop_frontmatter were filled in by adopt from the scan; _scout is a record of the machine check and is not used by the import.',
    ],
    common: common(),
    skills: [],
  }
}

function findRecord(records, arg) {
  const exact = records.filter((r) => r.id === arg)
  if (exact.length) return exact
  const lower = arg.toLowerCase()
  return records.filter((r) => r.name === lower || r.path.split('/').pop().toLowerCase() === lower)
}

function cmdAdopt(opts, names) {
  const p = paths(opts)
  if (!names.length) throw new UserError(`採用するスキルの名前か ID を指定してください(例: ${SELF} adopt incident-postmortem)`)
  if (opts.as && names.length > 1) throw new UserError('--as はスキルを 1 個だけ指定したときに使えます')
  const { records } = analyzeAll(p, loadSources(p.sources))
  const cfg = loadOverlays(p.overlays) ?? newOverlays()
  let refused = 0
  let added = 0
  for (const arg of names) {
    const found = findRecord(records, arg)
    if (!found.length) {
      console.error(`エラー: ${arg} が見つかりません。report.md の名前か ID を指定してください`)
      refused++
      continue
    }
    if (found.length > 1) {
      console.error(`エラー: ${arg} に当てはまるスキルが ${found.length} 個あります。ID で指定してください:`)
      for (const r of found) console.error(`  ${r.id}(${r.verdict})`)
      refused++
      continue
    }
    const r = found[0]
    const reasons = r.findings.filter((f) => f.level !== 'info')
    if (r.verdict === '不可' && !opts.force) {
      console.error(`${r.id} は「不可」なので追加しません。理由:`)
      for (const f of reasons.filter((x) => x.level === 'block')) console.error(`  - ${f.msg}`)
      console.error('  どうしても使うときは、理由を理解したうえで --force を付けます(ライセンスの理由なら使わないこと)。')
      refused++
      continue
    }
    const name = opts.as ?? r.name
    if (!NAME_RE.test(name)) {
      console.error(`エラー: ${r.id} の名前 ${name} はスキル名に使えません。--as <英小文字とハイフンの名前> で指定してください`)
      refused++
      continue
    }
    if (cfg.skills.some((s) => s.name === name)) {
      console.error(`エラー: ${name} は既に ${p.overlays} にあります(別の名前にするなら --as)`)
      refused++
      continue
    }
    const hints = harnessTodoLines(reasons)
    const entry = {
      name,
      repo: r.repo,
      path: r.path,
      files: r.plan.files,
      ...(r.plan.license ? { license: r.plan.license } : {}),
      ...(r.plan.dropFrontmatter.length ? { drop_frontmatter: r.plan.dropFrontmatter } : {}),
      trigger_ja: TODO_TRIGGER,
      extra: [TODO_EXTRA, ...hints],
      _scout: {
        id: r.id,
        verdict: r.verdict,
        commit: r.commit,
        adoptedAt: new Date().toISOString(),
        ...(r.verdict === '不可' ? { forced: true } : {}),
        reasons: reasons.map((f) => `[${LEVEL_LABEL[f.level]}] ${f.msg}`),
      },
    }
    cfg.skills.push(entry)
    added++
    console.log(`追加: ${name}(${r.id}、判定 ${r.verdict})`)
    for (const f of reasons) console.log(`  - [${LEVEL_LABEL[f.level]}] ${f.msg}`)
    const left = readdirSyncSafe(join(cloneDir(p.cache, r.repo), ...r.path.split('/'))).filter((f) => !r.plan.files.includes(f))
    if (left.length) console.log(`  同梱しないファイル: ${left.join(', ')}`)
  }
  if (added) {
    mkdirSync(dirname(p.overlays), { recursive: true })
    writeFileSync(p.overlays, JSON.stringify(cfg, null, 2) + '\n')
    console.log(`\n${p.overlays} を開いて、「TODO」をすべて書き換えてから build を実行してください。`)
    console.log('書く前に、そのスキルの SKILL.md と同梱ファイルを全文読んでください。')
  }
  return refused ? 1 : 0
}

function readdirSyncSafe(dir, prefix = '') {
  const out = []
  let ents = []
  try {
    ents = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of ents) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...readdirSyncSafe(join(dir, e.name), rel))
    else out.push(rel)
  }
  return out
}

// --------------------------------------------------------------------- build

function cmdBuild(opts) {
  const p = paths(opts)
  const cfg = loadOverlays(p.overlays)
  if (!cfg || !cfg.skills.length) throw new UserError(`採用したスキルがありません。先に ${SELF} adopt <名前> を実行してください(${p.overlays})`)

  const todo = cfg.skills.filter((s) => hasTodo(s.trigger_ja) || hasTodo(s.extra) || hasTodo(s.files))
  if (todo.length) {
    console.error(`まだ「TODO」が残っているので ZIP を作りません(${p.overlays}):`)
    for (const s of todo) console.error(`  - ${s.name}`)
    console.error('trigger_ja(日本語での依頼例)と extra(このスキルでの読み替え)を書き、TODO の行を消してから、もう一度実行してください。')
    return 1
  }

  // Re-check against the current cache: the upstream may have changed since adopt.
  const { records } = analyzeAll(p, loadSources(p.sources))
  let blocked = 0
  for (const s of cfg.skills) {
    const r = records.find((x) => x.repo === s.repo && x.path === s.path)
    if (!r) {
      console.error(`エラー: ${s.name}: ${s.repo}:${s.path} がキャッシュにありません(fetch を実行するか、overlays.json から外す)`)
      blocked++
      continue
    }
    if (s._scout?.commit && r.commit && s._scout.commit !== r.commit) {
      console.log(`注意: ${s.name}: 採用したとき (${s._scout.commit.slice(0, 12)}) から上流が更新されています (${r.commit.slice(0, 12)})。中身を読み直してください。`)
    }
    if (r.verdict === '不可' && !opts.force) {
      console.error(`${s.name} は今のチェックで「不可」です。理由:`)
      for (const f of r.findings.filter((x) => x.level === 'block')) console.error(`  - ${f.msg}`)
      blocked++
    } else if (r.verdict === '要確認') console.log(`注意: ${s.name} は「要確認」です。人が中身を読んで判断したものだけを使ってください。`)
  }
  if (blocked) {
    console.error('ZIP を作りませんでした。「不可」のものは overlays.json から外すか、理由を理解したうえで --force を付けます。')
    return 1
  }

  let done
  try {
    done = importUpstream({ src: clonesDir(p.cache), overlays: p.overlays, out: p.packages })
  } catch (e) {
    if (e instanceof ImportError || e instanceof GitError) {
      console.error(`取り込みに失敗しました: ${e.message}`)
      return 1
    }
    throw e
  }
  // Packages of skills no longer in the overlays are stale.
  const names = new Set(cfg.skills.map((s) => s.name))
  for (const d of readdirSync(p.packages)) {
    if (d === '_upstream' || names.has(d)) continue
    rmSync(join(p.packages, d), { recursive: true, force: true })
  }
  for (const f of existsSync(join(p.packages, '_upstream')) ? readdirSync(join(p.packages, '_upstream')) : []) {
    if (!names.has(f.replace(/\.SKILL\.md$/, ''))) rmSync(join(p.packages, '_upstream', f), { force: true })
  }

  // Pack each package on its own: the per-agent limits (8 skills, 350 files) apply to an
  // agent, not to this folder of zips.
  const tmp = `${p.zips}.tmp`
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  const results = []
  for (const d of done) {
    const r = spawnSync(process.execPath, [PACKER, d.dir, '--out', tmp, '--json'], { encoding: 'utf8', windowsHide: true })
    let j = null
    try {
      j = JSON.parse(r.stdout)
    } catch {}
    const res = j?.results?.[0]
    results.push({ name: d.name, ok: r.status === 0, zip: res?.zip, bytes: res?.bytes, problems: res?.problems ?? [r.stderr.trim()], warnings: res?.warnings ?? [] })
  }
  try {
    rmSync(p.zips, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    renameSync(tmp, p.zips)
  } catch (e) {
    console.error(`zips フォルダを置き換えられませんでした(${e.code ?? e.message})。zips フォルダや ZIP を開いているアプリを閉じて、もう一度実行してください。`)
    console.error(`作った ZIP は ${tmp} にあります。`)
    return 1
  }

  console.log('')
  for (const r of results) {
    if (r.ok) console.log(`  ${r.name}.zip (${r.bytes} バイト)`)
    else console.error(`  ${r.name}: ZIP にできませんでした`)
    for (const w of r.warnings) console.log(`    注意: ${w}`)
    if (!r.ok) for (const pr of r.problems) console.error(`    エラー: ${pr}`)
  }
  const ok = results.filter((r) => r.ok).length
  console.log(`\nZIP: ${ok} 個 -> ${p.zips}`)
  if (ok > LIMITS.skillsPerAgent) console.log(`注意: 1 つのエージェントに入れられるスキルは ${LIMITS.skillsPerAgent} 個までです。`)
  console.log('Agent Builder の「スキル」→「追加」で ZIP を 1 個ずつ追加します。追加する前に、packages/ の中身を人が全文読んでください。')
  return ok === results.length ? 0 : 1
}

// ------------------------------------------------------------------ discover

async function cmdDiscover(opts) {
  const p = paths(opts)
  const known = new Set(loadSources(p.sources).map((s) => s.repo.toLowerCase()))
  const topics = opts.topic.length ? opts.topic : ['agent-skills', 'claude-skills', 'copilot-skills']
  const seen = new Map()
  for (const topic of topics) {
    if (!/^[a-z0-9-]+$/.test(topic)) throw new UserError(`トピック ${topic} は英小文字・数字・ハイフンで指定してください`)
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(`topic:${topic}`)}&sort=stars&order=desc&per_page=30`
    let res
    try {
      res = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agent-toolkit-skill-scout', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(20000) })
    } catch (e) {
      console.error(`GitHub に接続できませんでした(${e.cause?.code ?? e.name}: ${e.message})。ネットワークやプロキシの設定を確認してください。`)
      return 1
    }
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset'))
      const when = reset ? new Date(reset * 1000).toLocaleTimeString('ja-JP', { hour12: false }) : '少し後'
      console.error(`GitHub の検索の回数制限に達しました(認証なしは 1 分に 10 回まで)。${when} 以降にもう一度実行してください。`)
      break
    }
    if (!res.ok) {
      console.error(`GitHub の検索が失敗しました(HTTP ${res.status})。`)
      continue
    }
    const body = await res.json()
    for (const it of body.items ?? []) {
      if (known.has(it.full_name.toLowerCase())) continue
      const prev = seen.get(it.full_name)
      if (prev) prev.topics.add(topic)
      else seen.set(it.full_name, { it, topics: new Set([topic]) })
    }
  }
  const list = [...seen.values()].sort((a, b) => b.it.stargazers_count - a.it.stargazers_count)
  if (!list.length) {
    console.log('新しい候補は見つかりませんでした。')
    return 0
  }
  console.log(`sources.json に無いリポジトリ(${list.length} 件、スター順)。自動では追加しません。`)
  console.log('使うときは、リポジトリの LICENSE と中身を確かめてから、sources.json に repo と globs(スキルのフォルダ)を書き足してください。\n')
  for (const { it, topics: t } of list) {
    console.log(`${it.full_name}  ★${it.stargazers_count}  ライセンス: ${it.license?.spdx_id ?? '不明'}  更新: ${(it.pushed_at ?? '').slice(0, 10)}  [${[...t].join(', ')}]`)
    if (it.description) console.log(`    ${it.description.replace(/\s+/g, ' ').slice(0, 140)}`)
  }
  return 0
}

// ---------------------------------------------------------------------- main

async function main(argv) {
  let parsed
  try {
    parsed = parseArgs(argv, {
      dir: 'string', sources: 'string', checks: 'string', overlays: 'string', source: 'string', keyword: 'string',
      as: 'string', force: 'bool', topic: 'list', help: 'bool',
    })
  } catch (e) {
    console.error(`エラー: ${e.message}(${SELF} --help で使い方を表示)`)
    return 2
  }
  const { opts, positionals } = parsed
  const [cmd, ...rest] = positionals
  if (opts.help || !cmd) {
    console.log(HELP.trim())
    return opts.help ? 0 : 2
  }
  try {
    switch (cmd) {
      case 'fetch':
        return cmdFetch(opts)
      case 'scan':
        return cmdScan(opts)
      case 'adopt':
        return cmdAdopt(opts, rest)
      case 'build':
        return cmdBuild(opts)
      case 'discover':
        return await cmdDiscover(opts)
      default:
        console.error(`エラー: ${cmd} というコマンドはありません(fetch / scan / adopt / build / discover)`)
        return 2
    }
  } catch (e) {
    if (e instanceof UserError || e instanceof ConfigError || e instanceof GitError) {
      console.error(`エラー: ${e.message}`)
      return 1
    }
    throw e
  }
}

process.exitCode = await main(process.argv.slice(2))

