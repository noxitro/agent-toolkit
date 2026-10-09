#!/usr/bin/env node
// Convert one agent skill (a folder with SKILL.md) into a Microsoft 365 Copilot (Agent
// Builder) skill zip, with a Japanese report of what was changed and what the machine
// checks found.
//
//   node skill2zip.mjs <input> [--out <dir>] [--overlay ja|none] [--overlay-file <json>]
//                      [--origin own|third-party] [--draft] [--force] [--allow-license-unknown]
//
// <input>: a local skill folder (or its SKILL.md), a GitHub folder URL
// (https://github.com/<owner>/<repo>/tree/<ref>/<path>, or .../blob/<ref>/<path>/SKILL.md),
// or the name of an installed skill (~/.claude/skills, .claude/skills, .github/skills,
// ~/.copilot/skills, ~/.agents/skills, Claude Code plugin caches).
//
// Needs Node 20+ (and git for GitHub input). Nothing from the input is executed; the
// source folder is never written. Exit codes: 0 zip written, 1 stopped (see the report),
// 2 bad arguments or unusable input.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from './lib/args.mjs'
import { ConfigError } from './lib/config.mjs'
import { renderConvertReport } from './lib/convert-report.mjs'
import { ConvertError, convert, overlaps } from './lib/convert.mjs'
import { GitError } from './lib/git.mjs'
import { InputError, resolveInput } from './lib/input.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const HELP = `
使い方: node skill2zip.mjs <スキル> [オプション]

  <スキル>  次のどれか
            - スキルのフォルダ(直下に SKILL.md があるもの)
            - GitHub のフォルダの URL: https://github.com/<owner>/<repo>/tree/<ブランチ>/<パス>
            - インストール済みのスキルの名前(~/.claude/skills、.claude/skills、.github/skills、
              ~/.copilot/skills、~/.agents/skills、Claude Code のプラグイン)

  --out <フォルダ>            出力先(既定: 今のフォルダの m365-zips)
  --overlay ja|none           日本語の「読み替え」の節を付けるか(既定: 第三者のスキルは ja、自作は none)
  --overlay-file <ファイル>   読み替えの定義(既定: <出力先>/<名前>.overlay.json。無ければ TODO 入りで作る)
  --origin own|third-party    自作か第三者のものか(既定: GitHub は third-party、それ以外は own)
  --draft                     読み替えに TODO が残っていても <名前>.draft.zip を作る(試し用)
  --force                     機械チェックで止まる理由があっても作る(理由はレポートと SOURCE.md に残る)
  --allow-license-unknown     自作のスキルで LICENSE が無くても続ける
  --checks <ファイル>         チェックの語句(既定: このスクリプトの lib/checks.json)

出力: <出力先>/<名前>.zip、<名前>.report.md(日本語のレポート)、node_modules/<名前>/(ZIP と同じ中身)。
第三者のスキルの ZIP には LICENSE.txt と SOURCE.md(出どころ・版・変更点)が入る。
レポートは機械による下調べ。使う前に、スキルの全文を人が読むこと。
`

function main(argv) {
  let parsed
  try {
    parsed = parseArgs(argv, {
      out: 'string', overlay: 'string', 'overlay-file': 'string', origin: 'string', draft: 'bool', force: 'bool',
      'allow-license-unknown': 'bool', checks: 'string', help: 'bool',
    })
  } catch (e) {
    console.error(`エラー: ${e.message}\n${HELP.trim()}`)
    return 2
  }
  const { opts, positionals } = parsed
  if (opts.help) {
    console.log(HELP.trim())
    return 0
  }
  if (positionals.length !== 1) {
    console.error(`エラー: 変換するスキルを 1 つ指定してください\n${HELP.trim()}`)
    return 2
  }
  if (opts.overlay && !['ja', 'none'].includes(opts.overlay)) {
    console.error('エラー: --overlay は ja か none です')
    return 2
  }
  if (opts.origin && !['own', 'third-party'].includes(opts.origin)) {
    console.error('エラー: --origin は own か third-party です')
    return 2
  }

  const out = resolve(opts.out ?? 'm365-zips')
  let input
  try {
    input = resolveInput(positionals[0], { log: (m) => console.log(m) })
  } catch (e) {
    if (e instanceof InputError || e instanceof GitError) {
      console.error(`エラー: ${e.message}`)
      return 2
    }
    throw e
  }
  try {
    if (overlaps(out, input.dir)) {
      console.error(`エラー: 出力先 ${out} が変換元のフォルダ ${input.dir} と重なります。元のフォルダは変えないので、--out で別の場所を指定してください`)
      return 2
    }
    const r = convert(input, {
      out,
      overlay: opts.overlay,
      overlayFile: opts['overlay-file'] ? resolve(opts['overlay-file']) : undefined,
      origin: opts.origin,
      draft: opts.draft,
      force: opts.force,
      allowLicenseUnknown: opts['allow-license-unknown'],
      checksPath: resolve(opts.checks ?? join(HERE, 'lib', 'checks.json')),
    })
    const originWhy = opts.origin ? '--origin で指定' : input.kind === 'github' ? 'GitHub から取得したので第三者のものとして扱う。自作なら --origin own' : 'ローカルのスキルなので自作として扱う。他人が作ったものなら --origin third-party'
    const command = ['node', 'skill2zip.mjs', ...argv.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ')
    const report = join(out, `${r.name}.report.md`)
    mkdirSync(out, { recursive: true })
    writeFileSync(report, renderConvertReport(r, { originWhy, command }))

    console.log(`判定(機械チェック): ${r.verdict}`)
    for (const b of r.stopping) console.error(`  止めた理由: ${b}`)
    for (const p of r.hardProblems) console.error(`  直せない問題: ${p}`)
    for (const f of r.forced) console.log(`  --force で通した: ${f}`)
    if (r.zip) console.log(`${r.draft ? '下書きの ZIP(Agent Builder に追加しない)' : 'ZIP'}: ${r.zip} (${r.bytes} バイト、${r.files.length} ファイル)`)
    else console.error('ZIP は作っていません。')
    if (r.overlay.created) console.log(`読み替えのひな形: ${r.overlay.file}(TODO を書き換えて、もう一度実行する)`)
    console.log(`レポート: ${report}`)
    if (r.staged) console.log(`中身(ZIP と同じ): ${r.staged}`)
    console.log('これは機械による下調べです。使う前に、SKILL.md と同梱ファイルを人が全文読んでください。')
    return r.zip ? 0 : 1
  } catch (e) {
    if (e instanceof ConvertError || e instanceof ConfigError || e instanceof GitError) {
      console.error(`エラー: ${e.message}`)
      return 2
    }
    throw e
  } finally {
    input.cleanup()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}

export { main }
