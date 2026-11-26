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
  // The shop floor starts quiet. Nothing in the outbox leaves the machine
  // until outboxSend is switched on and a command is there to carry it.
  outboxSend: false,
  outboxCommand: null,
  outboxRequiresApproval: true,
  outboxPerTick: 1,
  outboxMinGapSec: 60,
  outboxTimeoutSec: 120,
  memoryValueChars: 2000,
  memoryBlockChars: 4000,
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
