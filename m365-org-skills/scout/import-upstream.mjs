#!/usr/bin/env node
// Rebuild third-party skill packages from upstream clones (Node port of the former
// third-party/import_upstream.py; same output bytes for the same inputs).
//
//   node import-upstream.mjs --src <dir> [--overlays <file>] [--out <dir>] [--only name,...]
//
// <dir> holds one clone per upstream repository, named after the repository
// (e.g. <dir>/awesome-copilot, <dir>/cat-agent-skills). The overlays file lists the skills,
// the files to take and the Japanese "読み替え" section that is inserted before the
// original text. For each skill this writes:
//
//     <out>/<name>/SKILL.md        frontmatter (+ Japanese trigger words) + 読み替え + 原文
//     <out>/<name>/<other files>   copied byte for byte
//     <out>/<name>/LICENSE.txt     the repository's LICENSE (or the overlay's `license` path), unchanged
//     <out>/<name>/SOURCE.md       origin, commit and what was changed
//     <out>/_upstream/<name>.SKILL.md   the untouched upstream SKILL.md, for diffing on updates
//
// Every input of every listed skill is checked before any existing package is replaced:
// symbolic links (on disk, or recorded as such in git when the clone was made with
// core.symlinks=false), submodules and paths that resolve outside the upstream folder are
// refused, so a hostile clone cannot pull a local file into a package.
//
// Reads the clones; never runs anything inside them except `git rev-parse`, `git log`
// and `git ls-tree` for the commit id, date and file modes.

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from '../../shared/skills/m365-skill-pack/scripts/lib/args.mjs'
import { git, GitError } from './lib/git.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const THIRD_PARTY = resolve(HERE, '..', 'third-party')
const MARK_ORIGINAL = '## 原文'
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/

const HELP = `
使い方: node import-upstream.mjs --src <フォルダ> [--overlays <ファイル>] [--out <フォルダ>] [--only 名前,...]

  --src <フォルダ>       上流リポジトリの clone を置いたフォルダ(<フォルダ>/<リポジトリ名>)
  --overlays <ファイル>  取り込むスキルと読み替えの定義(既定: m365-org-skills/third-party/overlays.json)
  --out <フォルダ>       パッケージの出力先(既定: m365-org-skills/third-party)
  --only <名前,...>      指定したスキルだけを取り込む
`

export class ImportError extends Error {}

function fail(msg) {
  throw new ImportError(msg)
}

// Python's str.strip() whitespace set (str.isspace), which differs from String#trim.
const PY_SPACE = new Set([...' \t\n\r\x0b\x0c\x1c\x1d\x1e\x1f\x85\xa0                　'])
function pyStrip(s) {
  const cps = [...s]
  let a = 0
  let b = cps.length
  while (a < b && PY_SPACE.has(cps[a])) a++
  while (b > a && PY_SPACE.has(cps[b - 1])) b--
  return cps.slice(a, b).join('')
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Read UTF-8 text the way Python's open(encoding="utf-8") does: universal newlines. */
export function readText(path, where) {
  let text
  try {
    text = UTF8.decode(readFileSync(path))
  } catch (e) {
    fail(`${where}: ${path} は UTF-8 として読めません (${e.message})`)
  }
  return text.replace(/\r\n?/g, '\n')
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

function splitFrontmatter(text, where) {
  if (!text.startsWith('---\n')) fail(`${where}: YAML frontmatter がありません`)
  const end = text.indexOf('\n---\n', 4)
  if (end < 0) fail(`${where}: frontmatter が閉じていません`)
  return [text.slice(4, end).split('\n'), text.slice(end + 5)]
}

// YAML double-quoted escapes. Line breaks and tabs become spaces: the result goes into a
// one-line description.
const DQ_ESC = { '\\': '\\', '"': '"', '/': '/', ' ': ' ', '\t': ' ', n: ' ', r: ' ', t: ' ', b: ' ', f: ' ', v: ' ', a: ' ', e: ' ', N: ' ', _: ' ', L: ' ', P: ' ' }
function decodeDoubleQuoted(inner, where) {
  let out = ''
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (c === '"') fail(`${where}: description の引用符 (") が途中で閉じています。手で直してください`)
    if (c !== '\\') {
      out += c
      continue
    }
    const e = inner[++i]
    const hex = { x: 2, u: 4, U: 8 }[e]
    if (hex) {
      const h = inner.slice(i + 1, i + 1 + hex)
      if (h.length !== hex || !/^[0-9A-Fa-f]+$/.test(h)) fail(`${where}: description のエスケープ \\${e}${h} が不正です`)
      out += String.fromCodePoint(parseInt(h, 16))
      i += hex
    } else if (e !== undefined && Object.hasOwn(DQ_ESC, e)) out += DQ_ESC[e]
    else fail(`${where}: description のエスケープ \\${e ?? ''} には対応していません。手で直してください`)
  }
  return out
}

function unquote(value, where) {
  const v = pyStrip(value)
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replaceAll("''", "'")
  // Double quotes were refused by the Python original, so this never changes the output
  // for the existing overlays.
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) return decodeDoubleQuoted(v.slice(1, -1), where)
  if (v.startsWith('"') || ['>', '|'].includes(v.slice(0, 1)) || v.includes(' #')) {
    fail(`${where}: description の書き方 ${JSON.stringify(v.slice(0, 1))} には対応していません。手で直してください`)
  }
  return v
}

/** Index of the last line that belongs to the key on lines[i] (indented continuation, blank lines inside). */
function endOfEntry(lines, i) {
  let j = i
  for (let k = i + 1; k < lines.length; k++) {
    if (lines[k].startsWith(' ') || lines[k].startsWith('\t')) j = k
    else if (lines[k] !== '') break
  }
  return j
}

/** Description from its first line and continuation lines; a multi-line value is joined into one line. */
function descriptionValue(head, cont, where) {
  if (!cont.length) return { value: unquote(head, where), flattened: false }
  const v = pyStrip(head)
  const rest = cont.map((l) => pyStrip(l)).filter(Boolean)
  if (/^[>|][-+0-9]*$/.test(v)) return { value: rest.join(' '), flattened: true }
  if (/^[>|]/.test(v)) fail(`${where}: description の書き方 ${JSON.stringify(v)} には対応していません。手で直してください`)
  return { value: unquote([v, ...rest].join(' '), where), flattened: true }
}

const KEY_RE = /^([A-Za-z0-9_-]+):/

function frontmatterLines(original) {
  const text = original.replace(/\r\n?/g, '\n')
  if (!text.startsWith('---\n')) return null
  const end = text.indexOf('\n---\n', 4)
  return end < 0 ? null : text.slice(4, end).split('\n')
}

/** Top-level frontmatter keys other than name/description whose value spans indented lines. */
export function nestedFrontmatterKeys(original) {
  const lines = frontmatterLines(original) ?? []
  const keys = []
  for (let i = 0; i < lines.length; i++) {
    const key = KEY_RE.exec(lines[i])?.[1]
    if (!key) continue
    const j = endOfEntry(lines, i)
    if (j > i && key !== 'description' && key !== 'name') keys.push(key)
    i = j
  }
  return keys
}

function rebuildFrontmatter(lines, skill, where) {
  const triggerJa = skill.trigger_ja ?? ''
  const drop = new Set(skill.drop_frontmatter ?? [])
  if (drop.has('name') || drop.has('description')) fail(`${where}: drop_frontmatter に name / description は指定できません`)
  const missing = [...drop].filter((k) => !lines.some((l) => KEY_RE.exec(l)?.[1] === k))
  if (missing.length) fail(`${where}: drop_frontmatter の ${missing.join(', ')} が frontmatter にありません`)
  const out = []
  const notes = []
  let seen = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const key = KEY_RE.exec(line)?.[1]
    if (key && drop.has(key)) {
      i = endOfEntry(lines, i)
      notes.push(`- \`SKILL.md\` の frontmatter から \`${key}\` を外した(Agent Builder 向けの検査が読めない形のため。原文は \`_upstream/\` に残る)。`)
      continue
    }
    if (line.startsWith('description:')) {
      const j = endOfEntry(lines, i)
      const { value, flattened } = descriptionValue(line.slice('description:'.length), lines.slice(i + 1, j + 1), where)
      const desc = pyStrip(value + ' ' + triggerJa)
      out.push("description: '" + desc.replaceAll("'", "''") + "'")
      if (flattened) notes.push('- `SKILL.md` の複数行の description を 1 行にまとめた。')
      seen = true
      i = j
    } else out.push(line)
  }
  if (!seen) fail(`${where}: frontmatter に description がありません`)
  return { lines: out, notes }
}

/**
 * The package SKILL.md for an upstream SKILL.md: frontmatter with the Japanese trigger
 * words, the 読み替え section, then the original body untouched. The scout uses it to
 * pre-check what an import would produce.
 */
export function assembleSkillMd(original, skill, common, where = skill.name) {
  const [fmLines, body] = splitFrontmatter(original.replace(/\r\n?/g, '\n'), where)
  const fm = rebuildFrontmatter(fmLines, skill, where)
  const overlay = common.join('\n') + (skill.extra && skill.extra.length ? '\n' + skill.extra.join('\n') : '')
  const text = '---\n' + fm.lines.join('\n') + '\n---\n\n' + overlay + '\n\n' + MARK_ORIGINAL + '\n\n' + body.replace(/^\n+/, '')
  return { text, notes: fm.notes }
}

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

function within(root, p) {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Return the real path of root/rel, refusing links and paths that leave root. */
function checkedSource(root, rel, where) {
  const parts = rel.split('/')
  if (!rel || rel.startsWith('/') || rel.includes('\\') || rel.includes(':') || parts.some((p) => p === '' || p === '.' || p === '..')) {
    fail(`${where}: ファイルのパス ${JSON.stringify(rel)} が不正です`)
  }
  let probe = root
  for (const part of parts) {
    probe = join(probe, part)
    if (isLink(probe)) fail(`${where}: ${rel} はシンボリック リンクなので取り込みません`)
  }
  let realRoot
  let real
  try {
    realRoot = realpathSync.native(root)
  } catch {
    fail(`${where}: ${root} が見つかりません`)
  }
  try {
    real = realpathSync.native(join(root, ...parts))
  } catch {
    fail(`${where}: 上流のファイル ${rel} がありません`)
  }
  if (!within(realRoot, real)) fail(`${where}: ${rel} は ${root} の外を指しています`)
  if (!statSync(real).isFile()) fail(`${where}: 上流のファイル ${rel} がありません`)
  return real
}

/** Refuse files that git records as symlinks or submodules (checked out as plain files when core.symlinks=false). */
function checkGitModes(clone, relPaths, where) {
  const r = git(['-C', clone, 'ls-tree', '-z', '--full-tree', 'HEAD', '--', ...relPaths], { raw: true, allowFail: true })
  if (r.status !== 0) return
  for (const rec of r.stdout.toString('utf8').split('\0')) {
    if (!rec) continue
    const tab = rec.indexOf('\t')
    const mode = rec.slice(0, tab).split(' ')[0]
    const path = rec.slice(tab + 1)
    if (mode === '120000') fail(`${where}: ${path} は git 上でシンボリック リンクなので取り込みません`)
    if (mode === '160000') fail(`${where}: ${path} はサブモジュールなので取り込みません`)
  }
}

function gitOut(clone, args) {
  try {
    return git(['-C', clone, ...args]).trim()
  } catch (e) {
    fail(e instanceof GitError ? e.message : `git ${args.join(' ')} failed in ${clone}: ${e.message}`)
  }
}

// Code point order, as Python sorts str.
function cmpCodePoints(a, b) {
  const x = [...a]
  const y = [...b]
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0)
    if (d) return d
  }
  return x.length - y.length
}

/** Files under dir as os.walk lists them: links to directories are neither listed nor followed. */
function walkFiles(dir, base, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name)
    let isDir = ent.isDirectory()
    if (ent.isSymbolicLink()) {
      try {
        isDir = statSync(abs).isDirectory()
      } catch {
        isDir = false
      }
      if (!isDir) out.push(relative(base, abs).split(sep).join('/'))
      continue
    }
    if (isDir) walkFiles(abs, base, out)
    else out.push(relative(base, abs).split(sep).join('/'))
  }
  return out
}

/** Check one overlay entry and assemble its package in memory. Writes nothing. */
function prepare(skill, cfg, src) {
  const name = skill.name
  if (typeof skill.repo !== 'string' || skill.repo.split('/').length !== 2 || skill.repo.split('/').some((p) => !p || p === '.' || p === '..')) {
    fail(`${name}: repo ${JSON.stringify(skill.repo)} は owner/name の形で書いてください`)
  }
  if (typeof skill.path !== 'string' || !skill.path) fail(`${name}: path がありません`)
  const clone = join(src, skill.repo.split('/')[1])
  const upstream = join(clone, ...skill.path.split('/'))
  let plainDir = false
  try {
    plainDir = !isLink(upstream) && statSync(upstream).isDirectory()
  } catch {}
  if (!plainDir) fail(`${name}: 普通のフォルダではありません: ${upstream}`)
  if (!Array.isArray(skill.files) || !skill.files.includes('SKILL.md')) fail(`${name}: files に SKILL.md を含めてください`)
  const commit = gitOut(clone, ['rev-parse', 'HEAD'])
  const date = gitOut(clone, ['log', '-1', '--format=%cs'])

  const sources = {}
  for (const rel of skill.files) sources[rel] = checkedSource(upstream, rel, name)
  const licenseRel = skill.license ?? 'LICENSE'
  const licenseSrc = checkedSource(clone, licenseRel, name)
  if (!within(realpathSync.native(clone), realpathSync.native(upstream))) fail(`${name}: ${skill.path} は clone の外を指しています`)
  checkGitModes(clone, [...skill.files.map((f) => `${skill.path}/${f}`), licenseRel], name)

  const upstreamFiles = walkFiles(upstream, upstream).sort(cmpCodePoints)
  const leftOut = upstreamFiles.filter((f) => !skill.files.includes(f))

  const original = readText(sources['SKILL.md'], name)
  const { text: skillMd, notes } = assembleSkillMd(original, skill, cfg.common, name)

  const url = `https://github.com/${skill.repo}/tree/${commit}/${skill.path}`
  const licenseNote = skill.license === undefined ? '元のリポジトリの LICENSE をそのまま同梱' : `元のリポジトリの \`${skill.license}\` をそのまま同梱`
  const sourceMd = [
    '# 出典',
    '',
    `- 元のスキル: [${skill.repo}/${skill.path}](${url})`,
    `- 取り込んだ版: コミット \`${commit}\`(${date})`,
    `- ライセンス: \`LICENSE.txt\`(${licenseNote})`,
    '',
    '## 変更点',
    '',
    '- `SKILL.md` の description の末尾に、日本語での依頼例と使い分けを追加した。',
    '- `SKILL.md` の先頭に「Microsoft 365 Copilot で使うときの読み替え」の節を追加した。',
    `  原文は「${MARK_ORIGINAL}」以降に、手を加えずに残している。`,
    ...notes,
    leftOut.length ? `- 同梱しなかった元のファイル: ${leftOut.map((f) => '`' + f + '`').join(', ')}。` : '- 元のフォルダにあるファイルはすべて同梱した。',
    '',
  ].join('\n')

  return { name, skill, commit, sources, licenseSrc, skillMd, sourceMd, original }
}

/** Import every (or every --only) skill of the overlays file. Throws ImportError before writing anything. */
export function importUpstream({ src, overlays = join(THIRD_PARTY, 'overlays.json'), out = THIRD_PARTY, only = [] }) {
  if (!src) fail('--src を指定してください')
  let cfg
  try {
    cfg = JSON.parse(readText(overlays, overlays))
  } catch (e) {
    if (e instanceof ImportError) throw e
    fail(`${overlays}: JSON として読めません (${e.message})`)
  }
  if (!Array.isArray(cfg.common) || !Array.isArray(cfg.skills)) fail(`${overlays}: common と skills の配列が要ります`)
  const names = cfg.skills.map((s) => s.name)
  for (const n of names) if (typeof n !== 'string' || !NAME_RE.test(n)) fail(`${overlays}: スキル名 ${JSON.stringify(n)} が不正です`)
  const dup = names.filter((n, i) => names.indexOf(n) !== i)
  if (dup.length) fail(`${overlays}: スキル名が重複しています: ${[...new Set(dup)].join(', ')}`)
  const onlySet = new Set(only)
  const unknown = [...onlySet].filter((n) => !names.includes(n)).sort()
  if (unknown.length) fail(`--only の名前が ${overlays} にありません: ${unknown.join(', ')}`)

  // Check every input of every selected skill before any existing package is touched.
  const prepared = cfg.skills.filter((s) => !onlySet.size || onlySet.has(s.name)).map((s) => prepare(s, cfg, src))

  const done = []
  for (const p of prepared) {
    const dest = join(out, p.name)
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
    writeText(join(dest, 'SKILL.md'), p.skillMd)
    for (const rel of p.skill.files) {
      if (rel === 'SKILL.md') continue
      const target = join(dest, ...rel.split('/'))
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(p.sources[rel], target)
    }
    copyFileSync(p.licenseSrc, join(dest, 'LICENSE.txt'))
    writeText(join(dest, 'SOURCE.md'), p.sourceMd)
    writeText(join(out, '_upstream', p.name + '.SKILL.md'), p.original)
    done.push({ name: p.name, repo: p.skill.repo, commit: p.commit, dir: dest })
  }
  return done
}

function main(argv) {
  let args
  try {
    args = parseArgs(argv, { src: 'string', overlays: 'string', out: 'string', only: 'string', help: 'bool' })
  } catch (e) {
    console.error(`エラー: ${e.message}\n${HELP.trim()}`)
    return 2
  }
  const { opts } = args
  if (opts.help) {
    console.log(HELP.trim())
    return 0
  }
  if (!opts.src) {
    console.error(`エラー: --src を指定してください\n${HELP.trim()}`)
    return 2
  }
  try {
    const done = importUpstream({
      src: resolve(opts.src),
      overlays: resolve(opts.overlays ?? join(THIRD_PARTY, 'overlays.json')),
      out: resolve(opts.out ?? THIRD_PARTY),
      only: (opts.only ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    })
    for (const d of done) console.log(`${d.name}: ${d.repo} @ ${d.commit.slice(0, 12)}`)
    return 0
  } catch (e) {
    if (e instanceof ImportError || e instanceof GitError) {
      console.error(`エラー: ${e.message}`)
      console.error('既存のパッケージは書き換えていません。')
      return 2
    }
    throw e
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
