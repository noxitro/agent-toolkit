// Tiny flag parser so the three CLIs look alike. No dependencies.
//
//   parseArgs(argv, { out: 'string', store: 'bool', exclude: 'list', 'max-depth': 'number' })
//   -> { opts: { out, store, exclude: [], 'max-depth' }, positionals: [] }
//
// Accepts --flag value, --flag=value, and --no-flag for booleans.

export function parseArgs(argv, spec) {
  const opts = {}
  const positionals = []
  for (const [k, t] of Object.entries(spec)) opts[k] = t === 'list' ? [] : t === 'bool' ? false : undefined

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (!a.startsWith('--')) {
      positionals.push(a)
      continue
    }
    let key = a.slice(2)
    let val
    const eq = key.indexOf('=')
    if (eq !== -1) {
      val = key.slice(eq + 1)
      key = key.slice(0, eq)
    }
    if (key.startsWith('no-') && spec[key.slice(3)] === 'bool') {
      opts[key.slice(3)] = false
      continue
    }
    const type = spec[key]
    if (!type) throw new Error(`unknown option --${key}`)
    if (type === 'bool') {
      opts[key] = val === undefined ? true : !/^(0|false|no|off)$/i.test(val)
      continue
    }
    if (val === undefined) {
      if (i + 1 >= argv.length) throw new Error(`--${key} needs a value`)
      val = argv[++i]
    }
    if (type === 'number') {
      // Number('') is 0, so a blank value (`--max-depth=`) is refused explicitly.
      const n = val.trim() === '' ? NaN : Number(val)
      if (!Number.isFinite(n)) throw new Error(`--${key} must be a number`)
      opts[key] = n
    } else if (type === 'list') opts[key].push(val)
    else opts[key] = val
  }
  return { opts, positionals }
}

export function usage(text, code = 1) {
  ;(code === 0 ? console.log : console.error)(text.trim())
  process.exit(code)
}

/**
 * Report an uncaught error as `error: <message>` and exit 1, the code an uncaught throw
 * gives anyway: the scripts refuse bad input (a malformed bundle, a missing file) by
 * throwing, and a refusal needs no stack trace. An error that is not a plain Error
 * (TypeError, RangeError, ...) is more likely a bug, so it says how to get the stack;
 * M365_DEBUG=1 prints the stack for every error.
 */
export function installErrorHandler() {
  process.on('uncaughtException', (e) => {
    const debug = process.env.M365_DEBUG && process.env.M365_DEBUG !== '0'
    if (debug) console.error(e?.stack ?? e)
    else {
      console.error(`error: ${e?.message ?? e}`)
      if (e?.name && e.name !== 'Error') console.error(`  (${e.name}, unexpected: rerun with M365_DEBUG=1 for a stack trace)`)
    }
    process.exit(1)
  })
}
