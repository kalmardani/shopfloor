import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

export const HOME = process.env.SHOPFLOOR_HOME || join(homedir(), '.shopfloor')
export const DB_PATH = join(HOME, 'shopfloor.db')
export const CONFIG_PATH = join(HOME, 'config.json')

const DEFAULTS = {
  host: '127.0.0.1',
  port: 7420,
  token: null,
  tickSeconds: 20,
  maxConcurrentRuns: 2,
  maxUsdPerDay: 5,
  defaultTimeoutSec: 900,
  retryAfterQuotaSec: 1800,
  keepRunOutputChars: 20000,
  keepRunDays: 90,
  notifyCommand: null,
  digestAt: '07:30',
}

export function ensureHome () {
  mkdirSync(HOME, { recursive: true })
  return HOME
}

export function loadConfig () {
  ensureHome()
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    return { ...DEFAULTS, ...raw }
  } catch (err) {
    throw new Error(`config.json is not valid JSON (${CONFIG_PATH}): ${err.message}`)
  }
}

export function saveConfig (patch) {
  const next = { ...loadConfig(), ...patch }
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n')
  return next
}

export const configDefaults = DEFAULTS
