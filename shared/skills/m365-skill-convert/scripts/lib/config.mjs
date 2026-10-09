// JSON configuration files (checks.json, overlays.json, sources.json) and the error a
// bad one raises. Shared by the skill converter and the skill scout.

import { readFileSync } from 'node:fs'

export class ConfigError extends Error {}

export function readJson(path, what) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    throw new ConfigError(`${what} (${path}) が読めません: ${e.message}`)
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ''))
  } catch (e) {
    throw new ConfigError(`${what} (${path}) が JSON として読めません: ${e.message}`)
  }
}
