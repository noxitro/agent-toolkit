// Machine pre-screen of one skill folder, shared by the skill scout (m365-org-skills/scout)
// and the converter (skill2zip.mjs next to this folder). Everything here reads files;
// nothing from the skill is executed or imported. The result is a list of findings, each
// with a level that decides the verdict:
//
//   block  -> 不可       (license, Windows scripts, required CLI tools, network, hard limits)
//   review -> 要確認     (risk or privacy flags, unknown license, libraries the probe must confirm)
//   rewrite-> 要書き換え (text written for another tool, files that must be dropped)
//   info   -> no effect  (listed so the reader knows what the import will do)

import { builtinModules } from 'node:module'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, posix } from 'node:path'
import {
  LIMITS, RESOURCE_EXT, SCRIPT_EXT, WINDOWS_SCRIPT_EXT, extOf, globToRegExp, parseSimpleFrontmatter, validateSkillDir,
} from './m365-rules.mjs'
import { ConfigError, readJson } from './config.mjs'
import { assembleSkillMd, nestedFrontmatterKeys } from './overlay.mjs'
import { ADDED, REMOVED, STDLIB, WINDOWS_ONLY } from './python-stdlib.mjs'

export const VERDICTS = ['候補', '要書き換え', '要確認', '不可']
const LEVEL_VERDICT = { block: '不可', review: '要確認', rewrite: '要書き換え' }
export const LEVEL_LABEL = { block: '不可', review: '要確認', rewrite: '要書き換え', info: '参考' }

export function verdictOf(findings) {
  for (const level of ['block', 'review', 'rewrite']) if (findings.some((f) => f.level === level)) return LEVEL_VERDICT[level]
  return '候補'
}

export function loadChecks(path) {
  const cfg = readJson(path, 'checks.json')
  const compile = (list, key) =>
    (list ?? []).map((e) => {
      try {
        // A space in a pattern also matches a line break, so wrapped prose still matches.
        // claudeOnly: a feature the Microsoft 365 sandbox cannot honour; the converter treats
        // it as a blocker, the scout keeps it as 要書き換え.
        return { label: e.label, re: new RegExp(e.pattern.replace(/ /g, '\\s+'), (e.flags ?? 'i').replace('g', '') + 'g'), claudeOnly: e.claudeOnly === true }
      } catch (err) {
        throw new ConfigError(`${path}: ${key} の "${e.label}" の正規表現が不正です: ${err.message}`)
      }
    })
  return { privacy: compile(cfg.privacy, 'privacy'), harness: compile(cfg.harness, 'harness'), cliTools: compile(cfg.cliTools, 'cliTools') }
}

// ------------------------------------------------------------------ discovery

/** Skill folders of a clone: folders matching one of the globs that hold a SKILL.md (any letter case). */
export function findSkillDirs(clone, globs) {
  const res = globs.map((g) => globToRegExp(g))
  const found = []
  const walk = (abs, rel) => {
    let ents
    try {
      ents = readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    if (rel && res.some((re) => re.test(rel)) && ents.some((e) => e.isFile() && e.name.toLowerCase() === 'skill.md')) found.push(rel)
    for (const e of ents) {
      if (!e.isDirectory() || e.name === '.git') continue
      walk(join(abs, e.name), rel ? `${rel}/${e.name}` : e.name)
    }
  }
  walk(clone, '')
  return found.sort()
}

// ------------------------------------------------------------------ helpers

const TEXT_EXT = new Set([
  ...SCRIPT_EXT, ...WINDOWS_SCRIPT_EXT, '.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.html', '.htm', '.xml',
  '.csv', '.tsv', '.ini', '.config', '.toml', '.cfg', '.svg', '.css', '.jsx', '.tsx', '.rb', '.go', '.r', '.ipynb', '.sql',
])
const MAX_TEXT_BYTES = 2 * 1024 * 1024
const LICENSE_RE = /^(licen[cs]e|copying)([-._ ].*)?$/i
const CONTRIBUTING_RE = /^contributing([-._ ].*)?$/i
const GALLERY = new Set(['README.md', 'metadata.json'])
// XML / SVG namespace and schema URLs are identifiers, not network access.
const NAMESPACE_URL = /^https?:\/\/(www\.w3\.org|schemas\.openxmlformats\.org|schemas\.microsoft\.com|purl\.org|ns\.adobe\.com|openoffice\.org|schemas\.xmlsoap\.org|json-schema\.org|www\.apache\.org\/licenses|opensource\.org|creativecommons\.org)\b/i

function listFiles(dir, prefix = '', out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name)
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isSymbolicLink()) out.push({ rel, abs, symlink: true })
    else if (e.isDirectory()) {
      if (e.name !== '.git') listFiles(abs, rel, out)
    } else if (e.isFile()) out.push({ rel, abs, size: lstatSync(abs).size })
  }
  return out
}

function readTextFile(abs) {
  return readFileSync(abs, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n')
}

function lineAt(text, index) {
  let n = 1
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) n++
  return n
}

/** "SKILL.md:12" for the first hit, plus a count of the rest. */
function where(hits) {
  const [first] = hits
  return `${first.file}:${first.line}${hits.length > 1 ? ` ほか ${hits.length - 1} か所` : ''}`
}

function scanPattern(files, re, filter = () => true) {
  const hits = []
  for (const f of files) {
    if (!filter(f)) continue
    re.lastIndex = 0
    for (let m = re.exec(f.text); m; m = re.exec(f.text)) {
      hits.push({ file: f.rel, line: lineAt(f.text, m.index), match: m[0] })
      if (m[0] === '') re.lastIndex++
    }
  }
  return hits
}

/** "a, b, c ほか 37 件" */
function fileList(files, n = 3) {
  return files.slice(0, n).join(', ') + (files.length > n ? ` ほか ${files.length - n} 件(計 ${files.length} 件)` : '')
}

const short = (s, n = 60) => (s.length > n ? s.slice(0, n - 1) + '…' : s).replace(/\s+/g, ' ')

// ------------------------------------------------------------------ license

/** Classify a license text or a frontmatter `license:` value. */
export function classifyLicense(text) {
  const t = text.replace(/\s+/g, ' ')
  const restricted =
    /additional restrictions|not permitted to (distribute|copy|reproduce)|commons clause|non-?commercial|\bCC[- ]BY(-SA)?-NC\b|no ?derivatives|\bCC[- ]BY(-NC)?-ND\b/i.test(t) ||
    (/all rights reserved/i.test(t) && /\bmay not\b|\bmust not\b|\bprohibited\b/i.test(t) && !/permission is hereby granted|redistribution and use in source and binary forms|apache license/i.test(t)) ||
    /^\s*proprietary\b/i.test(t)
  if (restricted) return { id: 'restricted', label: '独自・制限付き' }
  if (/permission is hereby granted, free of charge/i.test(t) || /^\s*(the )?MIT( license)?\s*\.?$/i.test(t)) return { id: 'MIT', label: 'MIT' }
  if (/apache license,? version 2\.0|\bapache-2\.0\b|^\s*apache 2(\.0)?\s*$/i.test(t)) return { id: 'Apache-2.0', label: 'Apache-2.0' }
  if (/redistribution and use in source and binary forms|^\s*BSD-[0-9]-Clause\s*$/i.test(t)) return { id: 'BSD', label: 'BSD' }
  if (/permission to use, copy, modify, and\/or distribute this software for any purpose|^\s*ISC\s*$/i.test(t)) return { id: 'ISC', label: 'ISC' }
  if (/\bCC0\b|creative commons zero|public domain dedication/i.test(t)) return { id: 'CC0', label: 'CC0' }
  if (/creative commons attribution|\bCC[- ]BY(-SA)?(-[0-9.]+)?\b/i.test(t)) return { id: 'CC-BY', label: 'CC BY' }
  if (/^\s*(the )?unlicense\s*$|this is free and unencumbered software released into the public domain/i.test(t)) return { id: 'Unlicense', label: 'Unlicense' }
  return { id: 'unknown', label: '不明' }
}

const OPEN_LICENSES = new Set(['MIT', 'Apache-2.0', 'BSD', 'ISC', 'CC0', 'CC-BY', 'Unlicense'])

function licenseFilesAt(clone, relDir, special) {
  const abs = relDir ? join(clone, ...relDir.split('/')) : clone
  let ents = []
  try {
    ents = readdirSync(abs, { withFileTypes: true })
  } catch {
    return []
  }
  return ents
    .filter((e) => e.isFile() && LICENSE_RE.test(e.name))
    .map((e) => (relDir ? `${relDir}/${e.name}` : e.name))
    .filter((rel) => !special.has(rel))
    .sort()
}

function contributingNote(clone, chain) {
  for (const relDir of chain) {
    const abs = relDir ? join(clone, ...relDir.split('/')) : clone
    let ents = []
    try {
      ents = readdirSync(abs, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of ents) {
      if (!e.isFile() || !CONTRIBUTING_RE.test(e.name)) continue
      const text = readTextFile(join(abs, e.name)).replace(/\s+/g, ' ')
      const m = /(contributions?|submissions?|contributed (code|content)|you agree)[^.]{0,160}?licen[cs]ed? under (the )?([A-Za-z0-9.\- ]{2,30}?)(\s+licen[cs]e|[.,;)]|\s+and\b)/i.exec(text)
      if (m) return { file: relDir ? `${relDir}/${e.name}` : e.name, text: short(m[0], 140) }
    }
  }
  return null
}

function checkLicense(ctx, add) {
  const { clone, skillRel, special, frontmatter } = ctx
  const chain = []
  for (let d = skillRel; ; d = posix.dirname(d) === '.' ? '' : posix.dirname(d)) {
    chain.push(d)
    if (!d) break
  }
  const levels = chain.map((d) => ({ dir: d, files: licenseFilesAt(clone, d, special) })).filter((l) => l.files.length)
  const nearest = levels[0]
  const result = { file: null, id: 'none', label: '見つからない', own: false }
  const fm = frontmatter?.license
  const fmClass = fm && !/^complete terms in|^see /i.test(fm) ? classifyLicense(fm) : null

  if (nearest) {
    const file = nearest.files[0]
    const cls = classifyLicense(readTextFile(join(clone, ...file.split('/'))))
    Object.assign(result, { file, id: cls.id, label: cls.label, own: nearest.dir === skillRel })
    const parent = levels.find((l) => l.dir !== nearest.dir)
    if (result.own && parent) {
      const pcls = classifyLicense(readTextFile(join(clone, ...parent.files[0].split('/'))))
      if (pcls.id !== cls.id) {
        add(cls.id === 'restricted' ? 'block' : 'review', 'license',
          `スキルのフォルダに独自の ${file.split('/').pop()}(${cls.label})があり、リポジトリ全体の ${parent.files[0]}(${pcls.label})と違う。スキルの方が優先する`)
      } else add('info', 'license', `スキルのフォルダにも ${file.split('/').pop()} がある(${cls.label}。リポジトリ全体と同じ種類)`)
    }
  }
  if (fmClass && fmClass.id === 'restricted') Object.assign(result, { id: 'restricted', label: `独自・制限付き(frontmatter: ${short(fm, 40)})` })
  else if (fmClass && result.id === 'none' && fmClass.id !== 'unknown') add('review', 'license', `LICENSE ファイルは無いが、frontmatter に license: ${short(fm, 40)} とある。ファイルで許諾を確かめる`)
  else if (fmClass && result.file && fmClass.id !== 'unknown' && result.id !== 'unknown' && fmClass.id !== result.id) {
    add('review', 'license', `frontmatter の license: ${short(fm, 40)} と ${result.file}(${result.label})が食い違う`)
  } else if (fm && (!fmClass || fmClass.id === 'unknown')) add('info', 'license', `frontmatter の license: ${short(fm, 60)}`)

  if (result.id === 'restricted') add('block', 'license', `ライセンスが独自・制限付き(${result.file ?? 'frontmatter'})。複製・改変・配布の制限があり、社内配布できない`)
  else if (result.id === 'none') add('block', 'license', 'LICENSE が見つからない(スキルのフォルダからリポジトリの最上位まで)。許諾が不明なので使えない')
  else if (result.id === 'unknown') add('review', 'license', `${result.file} のライセンスの種類を判別できない。全文を読んで判断する`)
  else add('info', 'license', `ライセンス: ${result.label}(${result.file})`)

  const note = contributingNote(clone, chain)
  if (note) add('info', 'license', `${note.file}: 「${note.text}」`)
  return result
}

// ------------------------------------------------------------------ format

function checkFormat(ctx, add) {
  const { absDir, files, original, common, skillRel } = ctx
  const plan = { nestedKeys: [], name: null, description: null, gallery: [], dropped: [] }

  if (!files.some((f) => f.rel === 'SKILL.md')) {
    const alt = files.find((f) => f.rel.toLowerCase() === 'skill.md')
    add('block', 'format', `SKILL.md の名前が ${alt?.rel ?? '?'} になっている。取り込みスクリプトは名前を変えないので、このままでは使えない`)
    return plan
  }
  if (files.length > LIMITS.filesPerAgent) add('block', 'format', `ファイルが ${files.length} 個ある(1 エージェントの上限 ${LIMITS.filesPerAgent})`)
  const total = files.reduce((n, f) => n + (f.size ?? 0), 0)
  if (total > LIMITS.zipBytes) add('block', 'format', `合計 ${total} バイト(上限 ${LIMITS.zipBytes})`)

  // The validator reports one problem per file; group them so a folder of 40 schemas is one line.
  const v = validateSkillDir(absDir, {})
  const groups = new Map()
  const group = (level, key, text) => {
    if (!groups.has(key)) groups.set(key, { level, text, files: [] })
    return groups.get(key).files
  }
  for (const p of v.problems) {
    const msg = p.slice(p.indexOf(': ') + 2)
    const rel = msg.split(/\s/)[0]
    const base = rel.split('/').pop()
    if (/^SKILL\.md\b/.test(msg) || /frontmatter|instructions are/.test(msg)) continue // judged on the imported text below
    if (/symbolic link/.test(msg)) continue // reported from the git modes
    if (/has no extension/.test(msg)) {
      if (LICENSE_RE.test(base)) group('info', 'license', '拡張子の無い LICENSE は、取り込みで LICENSE.txt として同梱する').push(rel)
      else {
        plan.dropped.push(rel)
        group('rewrite', 'noext', '拡張子が無いので同梱できない。外す(スキルが使うファイルなら要確認)').push(rel)
      }
    } else if (/is a dotfile/.test(msg)) {
      plan.dropped.push(rel)
      group('info', 'dot', 'ドットファイルは外す(adopt は同梱しない)').push(rel)
    } else if (/Windows script and binary types/.test(msg)) {
      plan.dropped.push(rel)
      group('block', 'win', 'Windows のスクリプト・実行ファイル。Microsoft 365 では使えない').push(rel)
    } else if (/is not in the allowed resource or script list/.test(msg)) {
      plan.dropped.push(rel)
      group('rewrite', `ext${extOf(rel)}`, `同梱できない形式 (${extOf(rel)})。外すか変換する(スキルが使うファイルなら要確認)`).push(rel)
    } else if (/directories deep/.test(msg)) {
      plan.dropped.push(rel)
      group('rewrite', 'deep', `フォルダが深すぎる(上限 ${LIMITS.defaultMaxDepth} 段)。外すか構成を変える(取り込みスクリプトは構成を変えない)`).push(rel)
    } else if (/bytes \(max/.test(msg)) group('block', 'big', `大きすぎる(1 ファイル ${LIMITS.fileBytes} バイトまで)`).push(rel)
    else add('review', 'format', msg)
  }
  for (const g of groups.values()) add(g.level, 'format', `${g.text}: ${fileList(g.files)}`)
  for (const w of v.warnings) {
    const msg = w.slice(w.indexOf(': ') + 2)
    if (!/^SKILL\.md\b|instructions are/.test(msg)) add('info', 'format', msg)
  }
  for (const f of files) {
    if (!f.rel.includes('/') && GALLERY.has(f.rel)) plan.gallery.push(f.rel)
  }
  if (plan.gallery.length) add('info', 'format', `${plan.gallery.join(', ')} はギャラリー用の付属ファイル。外してよい(adopt は同梱しない)`)

  // Judge the SKILL.md the import would produce, not the upstream one: the importer joins a
  // multi-line description into one line and can drop nested frontmatter keys.
  plan.nestedKeys = nestedFrontmatterKeys(original)
  let assembled
  try {
    assembled = assembleSkillMd(original, { name: 'x', trigger_ja: '日本語での依頼例: TODO', extra: ['- TODO'], drop_frontmatter: plan.nestedKeys }, common, 'SKILL.md')
  } catch (e) {
    add('block', 'format', `取り込みスクリプトが SKILL.md の frontmatter を扱えない: ${e.message}`)
    return plan
  }
  if (plan.nestedKeys.length) add('info', 'format', `frontmatter の ${plan.nestedKeys.join(', ')} は複数行で、Agent Builder 向けの検査が読めないので取り込みで外す(drop_frontmatter)`)
  if (assembled.notes.some((n) => n.includes('複数行の description'))) add('info', 'format', '複数行の description は取り込みで 1 行にまとめる')
  try {
    const { data, body } = parseSimpleFrontmatter(assembled.text)
    plan.name = data.name || null
    plan.description = data.description || null
    if (!data.name) add('block', 'format', 'frontmatter に name が無い')
    else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(data.name) || data.name.length > 64) add('block', 'format', `frontmatter の name: ${data.name} が規則(英小文字とハイフン、64 文字以内)に合わない`)
    else if (data.name !== skillRel.split('/').pop()) add('info', 'format', `frontmatter の name (${data.name}) とフォルダ名が違う`)
    if (!data.description) add('block', 'format', 'frontmatter に description が無い')
    const upstreamBody = [...original.replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '')].length
    const chars = [...body].length
    if (upstreamBody >= LIMITS.skillInstructionChars) add('block', 'format', `SKILL.md の本文が ${upstreamBody} 文字(上限 ${LIMITS.skillInstructionChars} 未満)。原文を変えずには取り込めない`)
    else if (chars >= LIMITS.skillInstructionChars - 500) add('review', 'format', `読み替えの節を足すと本文が約 ${chars} 文字になり、上限 ${LIMITS.skillInstructionChars} に届く`)
  } catch (e) {
    add('block', 'format', `取り込んだ後の SKILL.md が検査を通らない: ${e.message}`)
  }
  return plan
}

// ------------------------------------------------------------------ dependencies

const NODE_BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, '')))

function pythonImports(text) {
  const mods = []
  for (const line of text.split('\n')) {
    let m = /^\s*import\s+(.+)$/.exec(line)
    if (m) {
      for (const part of m[1].split('#')[0].split(',')) {
        const name = part.trim().split(/\s+/)[0]
        if (/^[A-Za-z_][\w.]*$/.test(name)) mods.push(name.split('.')[0])
      }
      continue
    }
    m = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/.exec(line)
    if (m) mods.push(m[1].split('.')[0])
  }
  return mods
}

function nodeImports(text) {
  const mods = []
  const res = [
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const re of res) for (const m of text.matchAll(re)) mods.push(m[1])
  return mods
    .filter((s) => !s.startsWith('.') && !s.startsWith('/'))
    .map((s) => (s.startsWith('node:') ? { name: s, builtin: true } : { name: s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0], builtin: NODE_BUILTINS.has(s.split('/')[0]) }))
}

function checkDeps(ctx, add, checks) {
  const { files, textFiles } = ctx
  const byExt = {}
  for (const f of files) {
    const ext = extOf(f.rel)
    if (SCRIPT_EXT.has(ext) || WINDOWS_SCRIPT_EXT.has(ext)) byExt[ext] = (byExt[ext] ?? 0) + 1
  }
  const kinds = Object.entries(byExt).map(([e, n]) => `${e} ×${n}`)
  add('info', 'deps', kinds.length ? `スクリプト: ${kinds.join(', ')}` : 'スクリプトなし(テキストだけのスキル)')

  // Python: imports that are not in the standard library or the skill's own modules.
  const local = new Set()
  for (const f of files) {
    const parts = f.rel.split('/')
    if (extOf(f.rel) === '.py') local.add(parts[parts.length - 1].replace(/\.py$/, ''))
    for (const d of parts.slice(0, -1)) local.add(d)
  }
  const thirdParty = new Map()
  const removed = new Map()
  const winOnly = new Map()
  const newer = new Map()
  for (const f of textFiles.filter((t) => extOf(t.rel) === '.py')) {
    for (const mod of pythonImports(f.text)) {
      if (local.has(mod)) continue
      if (WINDOWS_ONLY.has(mod)) winOnly.set(mod, f.rel)
      else if (REMOVED[mod]) removed.set(mod, f.rel)
      else if (STDLIB.has(mod)) {
        if (ADDED[mod]) newer.set(mod, f.rel)
      } else if (!mod.startsWith('_')) thirdParty.set(mod, f.rel)
    }
  }
  if (thirdParty.size) add('review', 'deps', `標準ライブラリ以外の Python ライブラリ: ${[...thirdParty].map(([m, f]) => `${m}(${f})`).join(', ')}。サンドボックスに入っているかは probe で確かめる`)
  if (removed.size) add('review', 'deps', `Python 3.12/3.13 で削除された標準モジュール: ${[...removed].map(([m]) => `${m}(${REMOVED[m]} で削除)`).join(', ')}`)
  if (winOnly.size) add('block', 'deps', `Windows 専用の Python モジュール: ${[...winOnly.keys()].join(', ')}(サンドボックスは Linux)`)
  if (newer.size) add('info', 'deps', `Python 3.8 には無い標準モジュール: ${[...newer.keys()].map((m) => `${m}(${ADDED[m]} から)`).join(', ')}`)

  // Node.js / TypeScript.
  const jsFiles = textFiles.filter((t) => ['.js', '.mjs', '.cjs', '.ts', '.mts', '.jsx', '.tsx'].includes(extOf(t.rel)))
  const pkgs = new Map()
  for (const f of jsFiles) for (const m of nodeImports(f.text)) if (!m.builtin) pkgs.set(m.name, f.rel)
  if (pkgs.size) add('review', 'deps', `npm パッケージ: ${[...pkgs].map(([m, f]) => `${m}(${f})`).join(', ')}。サンドボックスではインストールできない`)
  const ts = files.filter((f) => ['.ts', '.mts'].includes(extOf(f.rel)))
  if (ts.length) add('review', 'deps', `TypeScript のスクリプト(${ts.map((f) => f.rel).join(', ')})。実行環境があるかは未確認`)
  const js = files.filter((f) => ['.js', '.mjs', '.cjs'].includes(extOf(f.rel)))
  if (js.length && !pkgs.size) add('review', 'deps', `JavaScript のファイル(${short(js.map((f) => f.rel).join(', '), 80)})。サンドボックスで Node.js が使えるかは未確認(HTML から読む部品なら問題ない)`)

  // CLI tools mentioned anywhere in the skill.
  for (const tool of checks.cliTools) {
    const hits = scanPattern(textFiles, tool.re)
    if (hits.length) add('block', 'deps', `CLI ツール ${tool.label} を使う(${where(hits)}: 「${short(hits[0].match, 40)}」)。サンドボックスには無い`)
  }
}

// ------------------------------------------------------------------ network and code risks

const NET_PATTERNS = [
  { label: 'requests', re: /^\s*(import\s+requests\b|from\s+requests\b)|\brequests\.(get|post|put|patch|delete|head|request|Session)\s*\(/gm, langs: ['.py'] },
  { label: 'urllib.request', re: /\burllib\.request\b|\burllib2\b|\burlopen\s*\(/g, langs: ['.py'] },
  { label: 'http.client', re: /\bhttp\.client\b|\bhttplib\b/g, langs: ['.py'] },
  { label: 'httpx / aiohttp / urllib3', re: /^\s*(import|from)\s+(httpx|aiohttp|urllib3|websockets?|paramiko)\b/gm, langs: ['.py'] },
  { label: 'socket', re: /^\s*(import|from)\s+(socket|smtplib|ftplib|telnetlib)\b/gm, langs: ['.py'] },
  { label: 'fetch', re: /(?<![\w.])fetch\s*\(/g, langs: ['.js', '.mjs', '.cjs', '.ts', '.mts'] },
  { label: 'axios / XMLHttpRequest / WebSocket', re: /\baxios\b|\bXMLHttpRequest\b|\bnew\s+WebSocket\b/g, langs: ['.js', '.mjs', '.cjs', '.ts', '.mts'] },
  { label: 'Node の http / net', re: /['"](node:)?(https?|net|tls|dgram|http2)['"]/g, langs: ['.js', '.mjs', '.cjs', '.ts', '.mts'] },
  { label: 'curl / wget', re: /\b(curl|wget)\s+[-\w"'$]/g, langs: ['.sh', '.bash', '.py', '.ps1', '.cmd', '.bat'] },
  { label: 'Invoke-WebRequest', re: /\bInvoke-(WebRequest|RestMethod)\b|\bNet\.WebClient\b/gi, langs: ['.ps1', '.cmd', '.bat'] },
]

const EXEC_PATTERNS = [
  { label: 'subprocess(shell=True)', level: 'review', re: /\bsubprocess\.\w+\([^)\n]*shell\s*=\s*True/g, langs: ['.py'] },
  { label: 'os.system / os.popen', level: 'review', re: /\bos\.(system|popen)\s*\(/g, langs: ['.py'] },
  { label: 'eval / exec', level: 'review', re: /(?<![\w.])(eval|exec)\s*\(/g, langs: ['.py'] },
  { label: 'eval / new Function', level: 'review', re: /(?<![\w.])eval\s*\(|\bnew\s+Function\s*\(/g, langs: ['.js', '.mjs', '.cjs', '.ts', '.mts', '.html', '.htm'] },
  { label: 'child_process', level: 'review', re: /\bchild_process\b/g, langs: ['.js', '.mjs', '.cjs', '.ts', '.mts'] },
  { label: 'eval(シェル)', level: 'review', re: /^\s*eval\s/gm, langs: ['.sh', '.bash'] },
  { label: 'subprocess(外部コマンドの起動)', level: 'info', re: /\bsubprocess\.(run|call|check_call|check_output|Popen)\s*\(/g, langs: ['.py'] },
]

function checkNetwork(ctx, add) {
  const { textFiles } = ctx
  const byLang = (langs) => (f) => langs.includes(extOf(f.rel))
  for (const p of NET_PATTERNS) {
    const hits = scanPattern(textFiles, p.re, byLang(p.langs))
    if (hits.length) add('block', 'network', `ネットワークを使う: ${p.label}(${where(hits)})。サンドボックスはネットワーク不可で、外部送信の恐れもある`)
  }
  for (const p of EXEC_PATTERNS) {
    const hits = scanPattern(textFiles, p.re, byLang(p.langs))
    if (hits.length) add(p.level, 'network', `${p.label}(${where(hits)})`)
  }
  // URLs inside scripts (namespace identifiers aside).
  const urlHits = scanPattern(textFiles, /https?:\/\/[^\s"'`<>)\]]+/g, (f) => SCRIPT_EXT.has(extOf(f.rel)) || WINDOWS_SCRIPT_EXT.has(extOf(f.rel))).filter((h) => !NAMESPACE_URL.test(h.match))
  if (urlHits.length) add('review', 'network', `スクリプトに URL がある(${where(urlHits)}: ${short(urlHits[0].match, 60)})`)

  // HTML resources: script elements and external references.
  for (const f of textFiles.filter((t) => ['.html', '.htm', '.svg'].includes(extOf(t.rel)))) {
    const scripts = [...f.text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    const external = scripts.filter((m) => /\bsrc\s*=\s*["']?(https?:)?\/\//i.test(m[1]))
    const links = [...f.text.matchAll(/<(link|img|iframe|object|embed|source)\b[^>]*\b(href|src)\s*=\s*["']?(https?:)?\/\/[^"'\s>]+/gi)]
    const inlineUrls = scripts.flatMap((m) => [...m[2].matchAll(/https?:\/\/[^\s"'`<>)]+/g)].map((u) => u[0])).filter((u) => !NAMESPACE_URL.test(u))
    const netInline = scripts.some((m) => /(?<![\w.])fetch\s*\(|XMLHttpRequest|navigator\.sendBeacon|new\s+WebSocket|new\s+Image\s*\(/.test(m[2]))
    if (external.length) add('review', 'network', `${f.rel} が外部のスクリプトを読み込む(${short(/src\s*=\s*["']?([^"'\s>]+)/i.exec(external[0][1])?.[1] ?? '', 70)})。開いた人のブラウザが外部に接続する`)
    if (links.length) add('review', 'network', `${f.rel} が外部の CSS・画像・フォントなどを参照する(${short(links[0][0].replace(/^.*?(https?:)?\/\//i, '//'), 60)})`)
    if (netInline || inlineUrls.length) add('review', 'network', `${f.rel} の script が通信する可能性がある(${netInline ? 'fetch などの呼び出し' : short(inlineUrls[0], 60)})`)
    else if (scripts.length && !external.length) add('info', 'network', `${f.rel} に script が ${scripts.length} 個ある(外部参照・通信は見当たらない)。全文を読んで確かめる`)
  }

  // Long base64 runs (obfuscated payloads), outside data:image URIs.
  for (const f of textFiles) {
    const re = /[A-Za-z0-9+/]{200,}={0,2}/g
    for (let m = re.exec(f.text); m; m = re.exec(f.text)) {
      const before = f.text.slice(Math.max(0, m.index - 60), m.index)
      if (/data:(image|font)\/[\w.+-]+;base64,$/i.test(before)) {
        add('info', 'network', `${f.rel}:${lineAt(f.text, m.index)} に埋め込み画像・フォント (data URI) がある`)
      } else add('review', 'network', `${f.rel}:${lineAt(f.text, m.index)} に長い base64 の塊がある(${m[0].length} 文字)。中身を確かめる`)
      break
    }
  }
}

// ------------------------------------------------------------------ text checks

function checkHarness(ctx, add, checks) {
  for (const h of checks.harness) {
    const hits = scanPattern(ctx.textFiles, h.re, (f) => !SCRIPT_EXT.has(extOf(f.rel)))
    if (hits.length) add('rewrite', 'harness', `読み替えが要る: ${h.label}(${where(hits)}: 「${short(hits[0].match, 30)}」)`, h.claudeOnly ? { claudeOnly: true } : undefined)
  }
}

function checkPrivacy(ctx, add, checks) {
  for (const p of checks.privacy) {
    const hits = scanPattern(ctx.textFiles, p.re, (f) => ['.md', '.txt', '.markdown'].includes(extOf(f.rel)))
    if (hits.length) add('review', 'privacy', `人に関わる判断を含む: ${p.label}(${where(hits)}: 「${short(hits[0].match, 40)}」)。社内で使ってよいか人が判断する(自動では落とさない)`)
  }
}

export function keywordScore(keywords, name, description) {
  if (!keywords.length) return null
  const n = (name ?? '').toLowerCase()
  const d = (description ?? '').toLowerCase()
  let score = 0
  for (const k of keywords) {
    if (n.includes(k)) score += 2
    if (d.includes(k)) score += 1
  }
  return score
}

// ------------------------------------------------------------------ entry point

/**
 * Pre-screen one skill folder. `special` is the list of non-plain git entries recorded
 * at fetch time ({ mode, path }), because a symlink is checked out as a plain file.
 */
export function analyzeSkill({ clone, skillRel, source, meta, checks, common, keywords = [] }) {
  const findings = []
  const add = (level, check, msg, extra) => findings.push({ level, check, msg, ...extra })
  const absDir = join(clone, ...skillRel.split('/'))
  const special = new Map((meta?.special ?? []).map((e) => [e.path, e.mode]))

  // SKILL.md first, so the first hit quoted in a finding is in the instructions themselves.
  const files = listFiles(absDir)
    .filter((f) => !f.symlink)
    .sort((a, b) => (a.rel === 'SKILL.md' ? -1 : b.rel === 'SKILL.md' ? 1 : 0))
  const textFiles = []
  for (const f of files) {
    if (special.has(`${skillRel}/${f.rel}`) && special.get(`${skillRel}/${f.rel}`) !== '100755') continue
    if (TEXT_EXT.has(extOf(f.rel)) && f.size <= MAX_TEXT_BYTES) textFiles.push({ ...f, text: readTextFile(f.abs) })
  }
  const skillFile = files.find((f) => f.rel === 'SKILL.md') ?? files.find((f) => f.rel.toLowerCase() === 'skill.md')
  const original = skillFile ? readFileSync(skillFile.abs, 'utf8') : ''
  let frontmatter = null
  try {
    frontmatter = Object.fromEntries(
      (original.replace(/\r\n?/g, '\n').match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '').split('\n').map((l) => /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].replace(/^['"]|['"]$/g, '')]),
    )
  } catch {}

  // Entries that git records as links or submodules.
  const executables = []
  for (const [path, mode] of special) {
    if (!path.startsWith(`${skillRel}/`)) continue
    const rel = path.slice(skillRel.length + 1)
    if (mode === '120000') add(rel === 'SKILL.md' ? 'block' : 'review', 'git', `${rel} はシンボリック リンク(取り込みでは拒否する。中身は別の場所にある)`)
    else if (mode === '160000') add('review', 'git', `${rel} はサブモジュール(中身は取得していない)`)
    else if (mode === '100755') executables.push(rel)
  }
  if (executables.length) add('info', 'git', `実行属性付きのファイル(このツールは何も実行しない): ${fileList(executables)}`)

  const ctx = { clone, skillRel, absDir, files, textFiles, original, frontmatter, special, common }
  const license = checkLicense(ctx, add)
  const plan = checkFormat(ctx, add)
  checkDeps(ctx, add, checks)
  checkNetwork(ctx, add)
  checkHarness(ctx, add, checks)
  checkPrivacy(ctx, add, checks)

  const name = plan.name ?? frontmatter?.name ?? skillRel.split('/').pop()
  const description = plan.description ?? frontmatter?.description ?? ''
  const order = { block: 0, review: 1, rewrite: 2, info: 3 }
  const checkOrder = ['license', 'git', 'format', 'deps', 'network', 'privacy', 'harness']
  findings.sort((a, b) => order[a.level] - order[b.level] || checkOrder.indexOf(a.check) - checkOrder.indexOf(b.check))
  const linkOrSub = new Set([...special].filter(([p, m]) => p.startsWith(`${skillRel}/`) && m !== '100755').map(([p]) => p.slice(skillRel.length + 1)))
  return {
    id: `${source.repo}:${skillRel}`,
    repo: source.repo,
    path: skillRel,
    name,
    description,
    commit: meta?.commit ?? null,
    date: meta?.date ?? null,
    license,
    verdict: verdictOf(findings),
    score: keywordScore(keywords, name, description),
    findings,
    // What adopt needs to write an overlay entry.
    plan: {
      files: files
        .map((f) => f.rel)
        .filter((rel) => !LICENSE_RE.test(rel) && !plan.gallery.includes(rel) && !plan.dropped.includes(rel) && !linkOrSub.has(rel))
        .filter((rel) => !rel.split('/').some((p) => p.startsWith('.') || p === '__pycache__' || p === 'node_modules'))
        .filter((rel) => RESOURCE_EXT.has(extOf(rel)) || SCRIPT_EXT.has(extOf(rel)))
        .sort(),
      license: license.file,
      dropFrontmatter: plan.nestedKeys,
    },
  }
}

