// Preload (`node -r`) that makes every path under $CI_ROOT resolve case-insensitively per
// segment, the way the default APFS and NTFS volumes do, so macOS/Windows-only behaviour
// can be tested on Linux. Only the calls unpack-output.mjs plans with are wrapped.
const fs = require('fs')
const path = require('path')
const { syncBuiltinESMExports } = require('module')

const ROOT = process.env.CI_ROOT
const orig = {}
function fold(p) {
  if (typeof p !== 'string') return p
  const abs = path.resolve(p)
  if (!abs.startsWith(ROOT + path.sep)) return p
  let cur = ROOT
  for (const seg of abs.slice(ROOT.length + 1).split(path.sep)) {
    let names = []
    try {
      names = orig.readdirSync(cur)
    } catch {
      /* not a directory (yet) */
    }
    cur = path.join(cur, names.find((n) => n.toLowerCase() === seg.toLowerCase()) ?? seg)
  }
  return cur
}
for (const k of ['lstatSync', 'statSync', 'readFileSync', 'writeFileSync', 'mkdirSync', 'unlinkSync', 'existsSync', 'readdirSync']) {
  orig[k] = fs[k]
  fs[k] = function (p, ...rest) {
    return orig[k].call(fs, fold(p), ...rest)
  }
}
const realpath = fs.realpathSync.native
fs.realpathSync.native = (p, ...rest) => realpath(fold(p), ...rest)
syncBuiltinESMExports()
