// The Japanese 読み替え overlay and the frontmatter handling shared by the skill converter
// (skill2zip.mjs) and the skill scout (m365-org-skills/scout/import-upstream.mjs). Moved
// here from import-upstream.mjs so both use one copy; the output bytes are unchanged.
//
// A package SKILL.md is: frontmatter (description + Japanese trigger words), the 読み替え
// section, then "## 原文" and the upstream body untouched.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MARK_ORIGINAL = '## 原文'
const HERE = dirname(fileURLToPath(import.meta.url))

export class ImportError extends Error {}

export function fail(msg) {
  throw new ImportError(msg)
}

// Python's str.strip() whitespace set (str.isspace), which differs from String#trim.
const PY_SPACE = new Set([...' \t\n\r\x0b\x0c\x1c\x1d\x1e\x1f\x85\xa0                　'])
export function pyStrip(s) {
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

export function splitFrontmatter(text, where) {
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

export function frontmatterLines(original) {
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

export function rebuildFrontmatter(lines, skill, where) {
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


/** Every top-level frontmatter key, in order, with its raw text (continuation lines included). */
export function topLevelFrontmatter(original) {
  const lines = frontmatterLines(original) ?? []
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const key = KEY_RE.exec(lines[i])?.[1]
    if (!key) continue
    const j = endOfEntry(lines, i)
    out.push({ key, raw: lines.slice(i, j + 1).join('\n'), multiline: j > i })
    i = j
  }
  return out
}

/**
 * SKILL.md with only `name` and a one-line `description` left in the frontmatter (the
 * body untouched). The same rebuild the overlay uses, without inserting the overlay.
 */
export function rewriteFrontmatter(original, drop, where = 'SKILL.md') {
  const [fmLines, body] = splitFrontmatter(original.replace(/\r\n?/g, '\n'), where)
  const fm = rebuildFrontmatter(fmLines, { drop_frontmatter: drop }, where)
  return { text: '---\n' + fm.lines.join('\n') + '\n---\n' + body, notes: fm.notes }
}

/** The default common 読み替え lines (Japanese), shipped next to this file. */
export function defaultCommon() {
  return JSON.parse(readFileSync(join(HERE, 'overlay-ja.json'), 'utf8').replace(/^﻿/, '')).common
}

export const TODO_TRIGGER = 'TODO: 日本語での依頼例(例: 「〜を作って」「〜をレビューして」)と、使わない場面(別のスキルを使う場面)を書く'
export const TODO_EXTRA = 'TODO: このスキルでの読み替えを書く(返すファイルの名前、接続できないサービスの言い換え、原文の例が当てはまらないときの扱いなど)。書き終えたらこの行を消す'

/** One TODO line per 要書き換え finding of the harness check (text written for another tool). */
export function harnessTodoLines(findings) {
  return findings
    .filter((f) => f.level === 'rewrite' && f.check === 'harness')
    .map((f) => `TODO: ${f.msg.replace(/^読み替えが要る: /, '')} を読み替える(例: 「添付・貼り付けで受け取る」「Teams・Outlook に言い換える」)。書き終えたらこの行を消す`)
}

export function hasTodo(v) {
  if (typeof v === 'string') return /TODO/.test(v)
  if (Array.isArray(v)) return v.some(hasTodo)
  return false
}
