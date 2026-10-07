#!/usr/bin/env node
// Validate one or more skill directories against the Microsoft 365 Copilot (Agent
// Builder) rules and write each as a .zip that Agent Builder accepts.
//
//   node pack-skill.mjs <skill-dir>... [--out <dir>] [--from-template] [--common <dir>]
//                       [--store] [--wrap] [--strict] [--keep-eol] [--max-depth N] [--json]
//   node pack-skill.mjs instructions <file>     # check an agent instruction block (<= 8,000 chars)
//
// Several directories in one call are validated together against the per-agent totals
// (8 skills, 350 files). --from-template treats SKILL.template.md as SKILL.md and, when
// a sibling `common/` directory exists (or --common is given), merges it into each skill.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs, usage } from './lib/args.mjs'
import { LIMITS, checkAgentInstructions, extractInstructions, validateSkillDir } from './lib/m365-rules.mjs'
import { writeZip } from './lib/zip.mjs'

const HELP = `
Usage: node pack-skill.mjs <skill-dir>... [options]
       node pack-skill.mjs instructions <file>

  --out <dir>        where to write <name>.zip (default: next to each skill directory)
  --from-template    use SKILL.template.md as SKILL.md and merge the sibling common/ directory
  --common <dir>     common directory to merge (overrides the sibling lookup)
  --store            no compression (fallback if Agent Builder rejects deflate)
  --wrap             put entries under <name>/ (fallback if the root layout is rejected)
  --strict           BOM and CRLF become errors instead of being fixed
  --keep-eol         do not normalise CRLF in scripts and text files
  --max-depth <n>    nested directories allowed (default ${LIMITS.defaultMaxDepth})
  --json             print a JSON summary instead of text
`

let args
try {
  args = parseArgs(process.argv.slice(2), {
    out: 'string', common: 'string', 'from-template': 'bool', store: 'bool', wrap: 'bool', strict: 'bool',
    'keep-eol': 'bool', 'max-depth': 'number', json: 'bool', help: 'bool',
  })
} catch (e) {
  usage(`${e.message}\n${HELP}`)
}
const { opts, positionals } = args
if (opts.help || positionals.length === 0) usage(HELP, opts.help ? 0 : 1)

// ------------------------------------------------------- instructions mode
if (positionals[0] === 'instructions') {
  const file = positionals[1]
  if (!file) usage('instructions mode needs a file')
  const text = extractInstructions(readFileSync(resolve(file), 'utf8'))
  const r = checkAgentInstructions(text, file)
  if (opts.json) console.log(JSON.stringify(r))
  else {
    console.log(`${file}: ${r.chars} characters (limit ${LIMITS.agentInstructionChars})`)
    for (const w of r.warnings) console.log(`  warning: ${w}`)
    for (const p of r.problems) console.error(`  error: ${p}`)
  }
  process.exit(r.problems.length ? 1 : 0)
}

// --------------------------------------------------------------- pack mode
if (positionals.length > LIMITS.skillsPerAgent) console.error(`error: ${positionals.length} skills exceed the ${LIMITS.skillsPerAgent} per agent that Agent Builder allows`)

const results = []
let totalFiles = 0
let anyProblem = positionals.length > LIMITS.skillsPerAgent
for (const dirArg of positionals) {
  const dir = resolve(dirArg)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    results.push({ dir: dirArg, problems: [`${dirArg}: not a directory`], warnings: [], notices: [] })
    anyProblem = true
    continue
  }
  let commonDir = opts.common ? resolve(opts.common) : null
  if (!commonDir && opts['from-template']) {
    const sibling = join(dirname(dir), 'common')
    if (existsSync(sibling) && basename(dir) !== 'common') commonDir = sibling
  }
  const v = validateSkillDir(dir, {
    fromTemplate: opts['from-template'], strict: opts.strict, keepEol: opts['keep-eol'],
    maxDepth: opts['max-depth'] ?? LIMITS.defaultMaxDepth, commonDir,
  })
  totalFiles += v.entries.length
  const name = v.name ?? basename(dir)
  // The name picks the zip file (and the --wrap prefix), so two skills sharing one would
  // silently overwrite each other's package.
  const twin = results.find((r) => r.name === name)
  if (twin) v.problems.push(`${dirArg}: \`name: ${name}\` is also used by ${twin.dir}; every skill needs its own name`)
  const result = { dir: dirArg, name, files: v.entries.length, problems: v.problems, warnings: v.warnings, notices: v.notices, skipped: v.skipped }
  if (!v.problems.length) {
    const zip = writeZip(v.entries, { store: opts.store, wrap: opts.wrap ? name : null })
    if (zip.length > LIMITS.zipBytes) v.problems.push(`${dirArg}: zip is ${zip.length} bytes (max ${LIMITS.zipBytes})`)
    else {
      result.zip = join(resolve(opts.out ?? dirname(dir)), `${name}.zip`)
      result.bytes = zip.length
      result.data = zip
    }
  }
  if (v.problems.length) anyProblem = true
  results.push(result)
}
if (totalFiles > LIMITS.filesPerAgent) {
  anyProblem = true
  results.push({ dir: '(all)', problems: [`${totalFiles} files across the given skills exceed the ${LIMITS.filesPerAgent} per agent that Agent Builder allows`], warnings: [], notices: [] })
}
// Nothing is written until every skill and the per-agent totals have passed.
if (!anyProblem) {
  for (const r of results) {
    if (!r.data) continue
    mkdirSync(dirname(r.zip), { recursive: true })
    writeFileSync(r.zip, r.data)
    delete r.data
  }
} else for (const r of results) delete r.data

if (opts.json) console.log(JSON.stringify({ ok: !anyProblem, results }, null, 2))
else {
  for (const r of results) {
    if (r.zip && !anyProblem) console.log(`${r.name}: ${r.files} files -> ${r.zip} (${r.bytes} bytes)`)
    else if (r.zip) console.log(`${r.name}: ${r.files} files validated; nothing written because another skill failed`)
    for (const n of r.notices ?? []) console.log(`  notice: ${n}`)
    for (const s of r.skipped ?? []) console.log(`  skipped: ${s}`)
    for (const w of r.warnings ?? []) console.log(`  warning: ${w}`)
    for (const p of r.problems ?? []) console.error(`  error: ${p}`)
  }
  if (!anyProblem) console.log('next: upload each .zip in Agent Builder > Configure > Skills > Add (whole .zip, never SKILL.md alone).')
}
process.exit(anyProblem ? 1 : 0)
