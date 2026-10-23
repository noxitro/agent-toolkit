#!/usr/bin/env node
// Checks the file-format rules this repository relies on, for every tracked file:
//
// - Line endings in the repository (the index) are LF. .gitattributes normalises text files on
//   commit, so a CRLF or mixed file in the index means a file escaped that (for example `-text`).
// - No UTF-8 BOM, except PowerShell scripts that contain non-ASCII text: Windows PowerShell 5.1
//   reads a .ps1 without a BOM as the ANSI code page, which silently breaks those lines.
// - Batch files (.bat / .cmd) are ASCII only: `chcp` inside a batch file breaks the parsing of
//   multibyte lines that follow it.
//
// Usage: node scripts/check-file-format.mjs   (exit 1 and one line per problem when something is off)
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const isAscii = (buf) => buf.every((b) => b < 0x80)

// `git ls-files --eol` prints: i/<index eol> w/<worktree eol> attr/<attributes>\t<path>
const listing = execFileSync('git', ['ls-files', '--eol', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const problems = []
let checked = 0

for (const entry of listing.split('\0')) {
  if (!entry) continue
  const tab = entry.indexOf('\t')
  const [index] = entry.slice(0, tab).trim().split(/\s+/)
  const path = entry.slice(tab + 1)
  if (index === 'i/-text' || index === 'i/') continue // binary or empty
  checked++

  if (index === 'i/crlf' || index === 'i/mixed') problems.push(`${path}: line endings in the repository are ${index.slice(2).toUpperCase()}, not LF`)

  let buf
  try {
    buf = readFileSync(path)
  } catch {
    continue // deleted in the working tree
  }
  const hasBom = buf.subarray(0, 3).equals(BOM)
  const body = hasBom ? buf.subarray(3) : buf

  if (/\.ps1$/i.test(path)) {
    if (!isAscii(body) && !hasBom) problems.push(`${path}: PowerShell script with non-ASCII text needs a UTF-8 BOM (Windows PowerShell 5.1)`)
  } else if (hasBom) {
    problems.push(`${path}: has a UTF-8 BOM`)
  }

  if (/\.(bat|cmd)$/i.test(path) && !isAscii(body)) problems.push(`${path}: batch files must be ASCII only`)
}

if (problems.length) {
  for (const p of problems) console.error(p)
  console.error(`\n${problems.length} problem(s) in ${checked} text files.`)
  process.exit(1)
}
console.log(`OK - ${checked} text files: LF in the repository, BOM only on PowerShell scripts that need it, ASCII batch files.`)
