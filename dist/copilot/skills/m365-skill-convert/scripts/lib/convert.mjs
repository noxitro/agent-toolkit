// The conversion pipeline behind skill2zip.mjs:
//
//   stage (copy; the source is never written) -> safe automatic fixes, each recorded
//   -> the skill scout's machine checks (lib/checks.mjs) -> blockers (stop unless --force)
//   -> frontmatter reduced to name + description -> optional Japanese 読み替え overlay
//   -> LICENSE.txt + SOURCE.md for third-party input -> the Agent Builder packer
//      (lib/m365-rules.mjs + lib/zip.mjs, byte-identical copies of m365-skill-pack's)
//
// Nothing from the skill is executed or imported; files are only read and copied.

import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, posix, resolve, sep } from 'node:path'
import { analyzeSkill, loadChecks, verdictOf } from './checks.mjs'
import { readJson } from './config.mjs'
import { JUNK_DIRS, JUNK_EXT, JUNK_NAMES, LIMITS, NORMALISE_EOL_EXT, RESOURCE_EXT, SCRIPT_EXT, extOf, parseSimpleFrontmatter, validateSkillDir } from './m365-rules.mjs'
import { MARK_ORIGINAL, TODO_EXTRA, TODO_TRIGGER, assembleSkillMd, defaultCommon, harnessTodoLines, hasTodo, rewriteFrontmatter, topLevelFrontmatter } from './overlay.mjs'
import { writeZip } from './zip.mjs'

export class ConvertError extends Error {}

const LICENSE_RE = /^(licen[cs]e|copying)([-._ ].*)?$/i
/** Files a skill gallery adds next to SKILL.md; dropped from the package unless SKILL.md mentions them. */
const GALLERY_ROOT_RE = /^(readme(\.[a-z]+)?|metadata\.json|changelog(\.[a-z]+)?|contributing(\.[a-z]+)?|code_of_conduct(\.[a-z]+)?)$/i
const TEXT_FIX_EXT = new Set([...NORMALISE_EOL_EXT, '.md'])

/** Frontmatter keys that only mean something to Claude Code and cannot be honoured by Agent Builder. */
const CLAUDE_ONLY_KEYS = {
  'allowed-tools': 'ツールの許可リスト(allowed-tools)。Agent Builder のサンドボックスでは効かず、制限が外れた状態で動く',
  context: 'context(fork でサブエージェントとして動かす指定)。Agent Builder にはサブエージェントが無い',
  agent: 'agent(サブエージェントの種類の指定)。Agent Builder にはサブエージェントが無い',
  hooks: 'hooks(スキルに付いたフック)。Agent Builder では動かない',
}
const REVIEW_KEYS = {
  'disable-model-invocation': '手動でだけ呼ぶ指定(disable-model-invocation)。Agent Builder では外れ、依頼の内容から自動で選ばれるようになる',
  'user-invocable': '呼び出し方の指定(user-invocable)。Agent Builder では外れる',
}

// ------------------------------------------------------------------ staging

function walk(dir, prefix = '', out = []) {
  for (const e of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isSymbolicLink()) out.push({ rel, link: true })
    else if (e.isDirectory()) {
      out.push({ rel, dir: true })
      walk(dir, rel, out)
    } else if (e.isFile()) out.push({ rel, size: lstatSync(join(dir, rel)).size })
    else out.push({ rel, other: true })
  }
  return out
}

/**
 * Copy the skill folder (and the license files of the folders above it, up to `root`) into
 * a fresh staging tree. Links and submodules stop the conversion: their content lives
 * somewhere else and could pull an unrelated local file into the package.
 */
function stage(input, stageRoot, fixes) {
  const prefix = input.rel ? '' : `${safeName(basename(input.dir))}/`
  const stagedRel = input.rel || prefix.slice(0, -1)
  const special = input.special.map((e) => ({ ...e, path: prefix + e.path }))

  const inSkill = (p) => p === stagedRel || p.startsWith(`${stagedRel}/`)
  const bad = special.filter((e) => (e.mode === '120000' || e.mode === '160000') && inSkill(e.path))
  const entries = walk(input.dir)
  const links = entries.filter((e) => e.link || e.other).map((e) => e.rel)
  if (bad.length || links.length) {
    const list = [...new Set([...bad.map((e) => `${e.path.slice(stagedRel.length + 1)}(git: ${e.mode === '120000' ? 'シンボリック リンク' : 'サブモジュール'})`), ...links.map((l) => `${l}(シンボリック リンク)`)])]
    throw new ConvertError(`シンボリック リンクかサブモジュールがあるので変換しません(中身が別の場所にあり、関係の無いファイルが ZIP に入りうる): ${list.join(', ')}。実体のファイルに置き換えてから、もう一度実行してください`)
  }

  const dest = join(stageRoot, ...stagedRel.split('/'))
  mkdirSync(dest, { recursive: true })
  for (const e of entries) {
    const parts = e.rel.split('/')
    if (parts.includes('.git')) continue
    if (e.dir) mkdirSync(join(dest, ...parts), { recursive: true })
    else copyFileSync(join(input.dir, ...parts), join(dest, ...parts))
  }
  if (entries.some((e) => e.rel === '.git' || e.rel.startsWith('.git/'))) fixes.push({ kind: 'drop', text: '.git/ を外した(git の管理フォルダ)', files: ['.git/'] })

  // License files of every folder from the skill's parent up to the root, at the same
  // relative place, so the scout's license check sees the same chain as in the source.
  if (input.rel) {
    let chainDir = input.dir
    let chainRel = input.rel
    while (chainRel.includes('/')) {
      chainDir = dirname(chainDir)
      chainRel = posix.dirname(chainRel)
      copyLicenses(chainDir, join(stageRoot, ...chainRel.split('/')))
    }
    copyLicenses(input.root, stageRoot)
  }
  return { stagedRel, special, dest }
}

function copyLicenses(fromDir, toDir) {
  let ents = []
  try {
    ents = readdirSync(fromDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of ents) {
    if (!e.isFile() || !LICENSE_RE.test(e.name)) continue
    mkdirSync(toDir, { recursive: true })
    copyFileSync(join(fromDir, e.name), join(toDir, e.name))
  }
}

const safeName = (s) => s.replace(/[^A-Za-z0-9._-]/g, '-') || 'skill'

// ------------------------------------------------------------------ automatic fixes

function group(fixes, kind, text, file) {
  let g = fixes.find((f) => f.kind === kind && f.text === text)
  if (!g) fixes.push((g = { kind, text, files: [] }))
  g.files.push(file)
}

/** The safe fixes, applied to the staged copy. Every change is recorded in `fixes`. */
function autoFix(dest, fixes, problems) {
  const skillPath = join(dest, 'SKILL.md')
  const skillText = readFileSync(skillPath, 'utf8').toLowerCase()
  const mentioned = (rel) => skillText.includes(rel.toLowerCase()) || skillText.includes(rel.split('/').pop().toLowerCase())
  const kept = []

  // Junk (caches, OS files) and gallery / dot files, deepest first so folders go as a whole.
  for (const e of walk(dest).sort((a, b) => b.rel.length - a.rel.length)) {
    const abs = join(dest, ...e.rel.split('/'))
    if (!existsSync(abs)) continue
    const base = e.rel.split('/').pop()
    if (e.dir ? JUNK_DIRS.has(base) : JUNK_NAMES.has(base) || JUNK_EXT.has(extOf(base))) {
      rmSync(abs, { recursive: true, force: true })
      group(fixes, 'drop', 'キャッシュ・OS が作るファイルを外した', e.dir ? `${e.rel}/` : e.rel)
    }
  }
  for (const e of walk(dest).sort((a, b) => a.rel.length - b.rel.length)) {
    const abs = join(dest, ...e.rel.split('/'))
    if (!existsSync(abs)) continue
    const base = e.rel.split('/').pop()
    const dot = base.startsWith('.')
    const gallery = !e.rel.includes('/') && !e.dir && GALLERY_ROOT_RE.test(base)
    if (!dot && !gallery) continue
    const shown = e.dir ? `${e.rel}/` : e.rel
    if (mentioned(e.rel)) {
      kept.push(shown)
      continue
    }
    rmSync(abs, { recursive: true, force: true })
    group(fixes, 'drop', dot ? 'ドットファイル・ドットフォルダを外した(Agent Builder に入れられない。SKILL.md から参照されていない)' : 'ギャラリー用の付属ファイルを外した(SKILL.md から参照されていない)', shown)
  }
  if (kept.length) fixes.push({ kind: 'keep', text: 'SKILL.md から参照されているので外さなかった(ドットファイルなら ZIP にできない)', files: kept })

  // LICENSE / COPYING without an extension: Agent Builder needs an allowed extension.
  for (const e of walk(dest)) {
    const base = e.rel.split('/').pop()
    if (e.dir || extOf(base) || !LICENSE_RE.test(base)) continue
    const to = `${e.rel}.txt`
    const absFrom = join(dest, ...e.rel.split('/'))
    const absTo = join(dest, ...to.split('/'))
    if (existsSync(absTo)) {
      if (readFileSync(absTo).equals(readFileSync(absFrom))) {
        rmSync(absFrom)
        group(fixes, 'rename', '拡張子の無いライセンス ファイルを外した(同じ中身の .txt がある)', e.rel)
      } else problems.push(`${e.rel} と ${to} が両方あり、中身が違う。どちらを同梱するか決めて、片方を消してください`)
      continue
    }
    renameSync(absFrom, absTo)
    group(fixes, 'rename', '拡張子の無いライセンス ファイルに .txt を付けた', `${e.rel} → ${to}`)
  }

  // Byte order marks and CRLF line endings in text files.
  for (const e of walk(dest)) {
    if (e.dir || !TEXT_FIX_EXT.has(extOf(e.rel))) continue
    const abs = join(dest, ...e.rel.split('/'))
    let data = readFileSync(abs)
    let changed = false
    if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
      data = data.subarray(3)
      group(fixes, 'text', 'UTF-8 の BOM を外した', e.rel)
      changed = true
    }
    if (data.includes(0x0d)) {
      const text = data.toString('utf8')
      if (text.includes('\r\n')) {
        data = Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8')
        group(fixes, 'text', '改行を CRLF から LF にした', e.rel)
        changed = true
      }
    }
    if (changed) writeFileSync(abs, data)
  }
}

/** Nearest license file from the skill folder up to the staging root: { abs, rel } or null. */
function nearestLicense(stageRoot, stagedRel) {
  for (let d = stagedRel; ; d = posix.dirname(d) === '.' ? '' : posix.dirname(d)) {
    const abs = d ? join(stageRoot, ...d.split('/')) : stageRoot
    let ents = []
    try {
      ents = readdirSync(abs, { withFileTypes: true })
    } catch {}
    const f = ents.filter((e) => e.isFile() && LICENSE_RE.test(e.name)).map((e) => e.name).sort()[0]
    if (f) return { abs: join(abs, f), rel: d ? `${d}/${f}` : f, own: d === stagedRel }
    if (!d) return null
  }
}

// ------------------------------------------------------------------ frontmatter

function classifyFrontmatter(original) {
  const keys = topLevelFrontmatter(original)
  const drop = []
  const items = []
  for (const k of keys) {
    if (k.key === 'name' || k.key === 'description') continue
    drop.push(k.key)
    const level = CLAUDE_ONLY_KEYS[k.key] ? 'block' : REVIEW_KEYS[k.key] ? 'review' : 'info'
    items.push({ key: k.key, raw: k.raw, level, why: CLAUDE_ONLY_KEYS[k.key] ?? REVIEW_KEYS[k.key] ?? null })
  }
  // allowed-tools nested under another key (agent-toolkit sources keep it in harness.claude.frontmatter).
  const fm = original.replace(/\r\n?/g, '\n').match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? ''
  if (!keys.some((k) => k.key === 'allowed-tools') && /^\s+allowed-tools\s*:/m.test(fm)) {
    const holder = keys.find((k) => /\n\s+allowed-tools\s*:/.test(k.raw))
    items.push({ key: `${holder?.key ?? '?'} の中の allowed-tools`, raw: '', level: 'block', why: CLAUDE_ONLY_KEYS['allowed-tools'] })
  }
  return { drop, items }
}

// ------------------------------------------------------------------ overlay file

function overlayTemplate(findings) {
  return {
    _comment: [
      'Japanese 読み替え for skill2zip.mjs --overlay ja. Replace every TODO, then run skill2zip.mjs again.',
      'trigger_ja: Japanese request examples appended to the description (when to use it, and when another skill should be used instead).',
      'extra: lines added under 「このスキルでの読み替え」, e.g. "- 結果は report.md としてファイルで返す。". common (optional) replaces the shared section.',
    ],
    trigger_ja: TODO_TRIGGER,
    extra: [TODO_EXTRA, ...harnessTodoLines(findings)],
  }
}

function loadOverlayFile(path) {
  const cfg = readJson(path, '読み替えの定義')
  if (typeof cfg.trigger_ja !== 'string' || !Array.isArray(cfg.extra) || cfg.extra.some((l) => typeof l !== 'string')) {
    throw new ConvertError(`${path}: trigger_ja(文字列)と extra(文字列の配列)が要ります`)
  }
  if (cfg.common !== undefined && (!Array.isArray(cfg.common) || cfg.common.some((l) => typeof l !== 'string'))) throw new ConvertError(`${path}: common は文字列の配列にしてください`)
  return cfg
}

// ------------------------------------------------------------------ SOURCE.md

function sourceMd({ input, lic, changes, forced }) {
  const g = input.git
  const lines = ['# 出典', '']
  if (input.kind === 'github') {
    lines.push(`- 元のスキル: [${g.repo}/${g.path}](${g.remote}/tree/${g.commit}/${g.path})`.replace(/\/\)$/, ')'))
    lines.push(`- 取り込んだ版: コミット \`${g.commit}\`(${g.date})${g.ref ? `、指定された ref: \`${g.ref}\`` : ''}`)
  } else if (g?.remote || g?.commit) {
    lines.push(`- 元のスキル: フォルダ \`${basename(input.dir)}\`${g.remote ? `(git のリモート: ${g.remote})` : ''}`)
    if (g.commit) lines.push(`- 変換したときのコミット: \`${g.commit}\`(${g.date ?? ''})。作業ツリーのコミットしていない変更を含むことがある`)
  } else lines.push(`- 元のスキル: フォルダ \`${basename(input.dir)}\`(git の情報なし)`)
  // Paths here are relative to the source repository (or the skill folder), never absolute:
  // this file travels inside the zip.
  if (!lic) lines.push('- ライセンス: 見つからなかった(--force で変換した)')
  else if (lic.own) lines.push(`- ライセンス: \`${lic.rel.split('/').pop()}\`(スキルのフォルダにあるもの。中身はそのまま)`)
  else lines.push(`- ライセンス: \`LICENSE.txt\`(元の \`${input.rel ? lic.rel : lic.rel.split('/').pop()}\` をそのまま同梱)`)
  lines.push(`- 変換: m365-skill-convert(skill2zip.mjs)で ${new Date().toISOString().slice(0, 10)} に Microsoft 365 Copilot(Agent Builder)向けに変換`, '')
  lines.push('## 変更点', '')
  for (const c of changes) lines.push(`- ${c}`)
  if (forced.length) {
    lines.push('', '## 機械チェックで止まったが、--force で変換した理由', '')
    for (const f of forced) lines.push(`- ${f}`)
  }
  lines.push('')
  return lines.join('\n')
}

// ------------------------------------------------------------------ entry point

/**
 * Convert one resolved input. Never throws for a blocked conversion: the result says why
 * and the caller writes the report. Throws ConvertError for input that cannot be staged.
 *
 * opts: { out, overlay ('ja'|'none'|undefined), overlayFile, origin, draft, force,
 *         allowLicenseUnknown, checksPath }
 */
export function convert(input, opts) {
  const origin = opts.origin ?? input.origin
  const overlay = opts.overlay ?? (opts.overlayFile || origin === 'third-party' ? 'ja' : 'none')
  if (opts.allowLicenseUnknown && origin !== 'own') throw new ConvertError('--allow-license-unknown は自作のスキル(--origin own)にだけ使えます。第三者のスキルはライセンスが確かめられないと使えません')

  const work = mkdtempSync(join(tmpdir(), 'skill2zip-stage-'))
  const stageRoot = join(work, 'node_modules', 'stage')
  const fixes = []
  const hardProblems = []
  try {
    const { stagedRel, special, dest } = stage(input, stageRoot, fixes)
    autoFix(dest, fixes, hardProblems)

    // The scout's machine checks, on the staged copy before any text is changed or added.
    const checks = loadChecks(opts.checksPath)
    const original = readFileSync(join(dest, 'SKILL.md'), 'utf8')
    const common = defaultCommon()
    const meta = { commit: input.git?.commit ?? null, date: input.git?.date ?? null, special }
    const record = analyzeSkill({ clone: stageRoot, skillRel: stagedRel, source: { repo: input.git?.repo ?? 'local' }, meta, checks, common })

    // Third-party: the license that applies goes into the package as LICENSE.txt.
    const lic = nearestLicense(stageRoot, stagedRel)
    if (origin === 'third-party' && lic && !lic.own) {
      copyFileSync(lic.abs, join(dest, 'LICENSE.txt'))
      fixes.push({ kind: 'add', text: `リポジトリの ${lic.rel} を LICENSE.txt として同梱した`, files: ['LICENSE.txt'] })
    }

    const fm = classifyFrontmatter(original)
    const blockers = []
    for (const f of record.findings) {
      if (f.check === 'license' && f.level === 'block' && record.license.id === 'none' && opts.allowLicenseUnknown) continue
      if (f.level === 'block') blockers.push(f.msg)
      else if (f.claudeOnly) blockers.push(`Claude Code 専用の機能: ${f.msg.replace(/^読み替えが要る: /, '')}。Agent Builder のサンドボックスでは動かない`)
    }
    for (const it of fm.items) if (it.level === 'block') blockers.push(`frontmatter の ${it.key}: ${it.why}`)

    // The package SKILL.md: frontmatter reduced to name + description, then the overlay.
    let overlayInfo = { mode: overlay, file: null, created: false, todo: false }
    let newSkill = original
    const changes = []
    if (overlay === 'ja') {
      const name = record.name
      const file = opts.overlayFile ?? join(opts.out, `${safeName(name)}.overlay.json`)
      let cfg
      if (existsSync(file)) cfg = loadOverlayFile(file)
      else {
        if (opts.overlayFile) throw new ConvertError(`読み替えの定義 ${file} がありません`)
        cfg = overlayTemplate(record.findings)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n')
        overlayInfo.created = true
      }
      overlayInfo = { ...overlayInfo, file, todo: hasTodo(cfg.trigger_ja) || hasTodo(cfg.extra), trigger: cfg.trigger_ja, extra: cfg.extra }
      try {
        const assembled = assembleSkillMd(original, { name, trigger_ja: cfg.trigger_ja, extra: cfg.extra, drop_frontmatter: fm.drop }, cfg.common ?? common, 'SKILL.md')
        newSkill = assembled.text
        if (assembled.notes.some((x) => x.includes('複数行の description'))) changes.push('`SKILL.md` の複数行の description を 1 行にまとめた。')
        changes.push('`SKILL.md` の description の末尾に、日本語での依頼例と使い分けを追加した。')
        changes.push(`\`SKILL.md\` の先頭に「Microsoft 365 Copilot で使うときの読み替え」の節を追加した。原文は「${MARK_ORIGINAL}」以降に、手を加えずに残している。`)
      } catch (e) {
        hardProblems.push(`SKILL.md の frontmatter を扱えない: ${e.message}`)
      }
    } else if (fm.drop.length || !simpleFrontmatter(original)) {
      try {
        const rewritten = rewriteFrontmatter(original, fm.drop)
        newSkill = rewritten.text
        if (rewritten.notes.some((x) => x.includes('複数行の description'))) changes.push('`SKILL.md` の複数行の description を 1 行にまとめた。')
      } catch (e) {
        hardProblems.push(`SKILL.md の frontmatter を扱えない: ${e.message}`)
      }
    }
    if (fm.drop.length) changes.push(`\`SKILL.md\` の frontmatter から ${fm.drop.map((k) => `\`${k}\``).join(', ')} を外した(Agent Builder は name と description だけを使う)。`)
    if (newSkill !== original) writeFileSync(join(dest, 'SKILL.md'), newSkill)
    for (const f of fixes) if (f.kind !== 'keep') changes.push(`${f.text}: ${f.files.map((x) => `\`${x}\``).join(', ')}`)

    if (overlay === 'ja' && overlayInfo.todo && !opts.draft) blockers.push(`読み替えに TODO が残っている(${overlayInfo.file})。書き換えてから、もう一度実行する(試しに作るだけなら --draft)`)

    const forced = opts.force ? blockers.filter((b) => !b.startsWith('読み替えに TODO')) : []
    const stopping = opts.force ? blockers.filter((b) => b.startsWith('読み替えに TODO')) : blockers

    // --force: files Agent Builder never accepts (Windows scripts and binaries, other types,
    // dotfiles) are left out instead of failing the pack. Each one is recorded.
    if (opts.force) {
      const dropped = []
      for (const e of walk(dest)) {
        if (e.dir || e.rel === 'SKILL.md') continue
        const ext = extOf(e.rel)
        if (e.rel.split('/').some((p) => p.startsWith('.')) || !ext || (!RESOURCE_EXT.has(ext) && !SCRIPT_EXT.has(ext))) {
          rmSync(join(dest, ...e.rel.split('/')))
          dropped.push(e.rel)
        }
      }
      if (dropped.length) {
        const t = 'Agent Builder が受け付けない形式のファイルを --force の指定で外した(スキルがそれを使う手順は動かない)'
        fixes.push({ kind: 'drop', text: t, files: dropped })
        changes.push(`${t}: ${dropped.map((x) => `\`${x}\``).join(', ')}`)
        forced.push(`${t}: ${dropped.join(', ')}`)
      }
    }

    if (origin === 'third-party') {
      writeFileSync(join(dest, 'SOURCE.md'), sourceMd({ input, lic, changes, forced }))
    }

    // The Agent Builder packer: the same validator and ZIP writer as pack-skill.mjs.
    const v = validateSkillDir(dest, {})
    const result = {
      input, origin, overlay: overlayInfo, record, verdict: verdictOf(record.findings), fixes, frontmatter: fm, changes,
      blockers, forced, stopping, hardProblems: [...hardProblems, ...v.problems.map((p) => p.slice(p.indexOf(': ') + 2))],
      warnings: v.warnings.map((p) => p.slice(p.indexOf(': ') + 2)), name: v.name ?? record.name ?? basename(input.dir),
      files: v.entries.map((e) => ({ name: e.name, bytes: e.data.length })), zip: null, staged: null, draft: false,
    }
    // A zip left from an earlier run would not match this report: remove it first.
    for (const old of [`${result.name}.zip`, `${result.name}.draft.zip`].map((f) => join(opts.out, f))) {
      if (existsSync(old) && lstatSync(old).isFile()) {
        rmSync(old)
        result.removedOld = [...(result.removedOld ?? []), old]
      }
    }
    if (!result.hardProblems.length && !stopping.length) {
      const zip = writeZip(v.entries, {})
      if (zip.length > LIMITS.zipBytes) result.hardProblems.push(`ZIP が ${zip.length} バイトになる(上限 ${LIMITS.zipBytes})`)
      else {
        const draft = overlay === 'ja' && overlayInfo.todo
        mkdirSync(opts.out, { recursive: true })
        result.zip = join(opts.out, `${result.name}${draft ? '.draft' : ''}.zip`)
        result.draft = draft
        result.bytes = zip.length
        writeFileSync(result.zip, zip)
      }
    }
    // What a person must read: the staged package, exactly what went (or would go) into the
    // zip. Under node_modules so test runners in the output folder never run its scripts.
    const staged = join(opts.out, 'node_modules', safeName(result.name))
    if (overlaps(staged, input.dir)) result.warnings.push(`読むためのコピーを ${staged} に置けなかった(変換元のフォルダと重なる)`)
    else {
      rmSync(staged, { recursive: true, force: true })
      mkdirSync(dirname(staged), { recursive: true })
      copyTree(dest, staged)
      result.staged = staged
    }
    return result
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 3 })
  }
}

/** True when one path is the other or inside it. */
export function overlaps(a, b) {
  const norm = (p) => resolve(p).toLowerCase().replace(/[\\/]+$/, '') + sep
  const x = norm(a)
  const y = norm(b)
  return x.startsWith(y) || y.startsWith(x)
}

function simpleFrontmatter(text) {
  try {
    parseSimpleFrontmatter(text)
    return true
  } catch {
    return false
  }
}

function copyTree(from, to) {
  mkdirSync(to, { recursive: true })
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) copyTree(join(from, e.name), join(to, e.name))
    else if (e.isFile()) copyFileSync(join(from, e.name), join(to, e.name))
  }
}
