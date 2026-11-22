import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { ensureHome, DB_PATH } from './config.mjs'
import { nextRun, silenceWindowSec, parseSchedule } from './schedule.mjs'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  role TEXT,
  adapter TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  max_usd_day REAL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  name TEXT NOT NULL UNIQUE,
  goal TEXT,
  schedule TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  timeout_sec INTEGER,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  silence_sec INTEGER,
  heartbeat_token TEXT,
  next_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
  worker_id TEXT,
  trigger TEXT NOT NULL DEFAULT 'schedule',
  status TEXT NOT NULL,
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  exit_code INTEGER,
  cost_usd REAL NOT NULL DEFAULT 0,
  summary TEXT,
  stdout TEXT,
  stderr TEXT
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  job_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  question TEXT,
  requested_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT,
  note TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  level TEXT NOT NULL,
  kind TEXT NOT NULL,
  job_id TEXT,
  run_id TEXT,
  message TEXT
);
CREATE TABLE IF NOT EXISTS heartbeats (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  last_at INTEGER NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS runs_job_idx ON runs(job_id, queued_at DESC);
CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status);
CREATE INDEX IF NOT EXISTS events_at_idx ON events(at DESC);
`

let db = null

export function open () {
  if (db) return db
  ensureHome()
  db = new DatabaseSync(DB_PATH)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(SCHEMA)
  return db
}

export function close () {
  if (db) { db.close(); db = null }
}

const now = () => Date.now()
const toJson = (v) => JSON.stringify(v ?? {})
const parse = (v, fallback = {}) => { try { return JSON.parse(v) } catch { return fallback } }

function hydrateWorker (row) {
  if (!row) return null
  return { ...row, config: parse(row.config), enabled: !!row.enabled }
}

function hydrateJob (row) {
  if (!row) return null
  return { ...row, payload: parse(row.payload), enabled: !!row.enabled, requires_approval: !!row.requires_approval }
}

/* ---------- workers ---------- */

export function createWorker ({ name, role = null, adapter, config = {}, maxUsdDay = null, enabled = true }) {
  const d = open()
  const id = randomUUID()
  d.prepare(`INSERT INTO workers (id, name, role, adapter, config, max_usd_day, enabled, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, name, role, adapter, toJson(config), maxUsdDay, enabled ? 1 : 0, now())
  return getWorker(id)
}

export function updateWorker (id, patch) {
  const d = open()
  const cur = getWorker(id)
  if (!cur) throw new Error(`no such worker: ${id}`)
  const next = {
    name: patch.name ?? cur.name,
    role: patch.role ?? cur.role,
    adapter: patch.adapter ?? cur.adapter,
    config: patch.config ? toJson(patch.config) : toJson(cur.config),
    max_usd_day: patch.maxUsdDay === undefined ? cur.max_usd_day : patch.maxUsdDay,
    enabled: patch.enabled === undefined ? (cur.enabled ? 1 : 0) : (patch.enabled ? 1 : 0),
  }
  d.prepare(`UPDATE workers SET name=?, role=?, adapter=?, config=?, max_usd_day=?, enabled=? WHERE id=?`)
    .run(next.name, next.role, next.adapter, next.config, next.max_usd_day, next.enabled, id)
  return getWorker(id)
}

export function getWorker (idOrName) {
  const d = open()
  return hydrateWorker(d.prepare('SELECT * FROM workers WHERE id = ? OR name = ?').get(idOrName, idOrName))
}

export function listWorkers () {
  return open().prepare('SELECT * FROM workers ORDER BY name').all().map(hydrateWorker)
}

export function deleteWorker (id) {
  return open().prepare('DELETE FROM workers WHERE id = ?').run(id).changes
}

/* ---------- jobs ---------- */

export function createJob ({ workerId, name, goal = null, schedule, payload = {}, timeoutSec = null,
  requiresApproval = false, silenceSec = undefined, enabled = true }) {
  const d = open()
  parseSchedule(schedule) // throws early on a schedule nobody can read
  const worker = getWorker(workerId)
  if (!worker) throw new Error(`no such worker: ${workerId}`)
  const id = randomUUID()
  const silence = silenceSec === undefined ? silenceWindowSec(schedule) : silenceSec
  d.prepare(`INSERT INTO jobs (id, worker_id, name, goal, schedule, payload, timeout_sec, requires_approval,
             silence_sec, heartbeat_token, next_at, enabled, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, worker.id, name, goal, schedule, toJson(payload), timeoutSec, requiresApproval ? 1 : 0,
      silence, randomUUID().replaceAll('-', ''), enabled ? nextRun(schedule) : null, enabled ? 1 : 0, now())
  return getJob(id)
}

export function updateJob (id, patch) {
  const d = open()
  const cur = getJob(id)
  if (!cur) throw new Error(`no such job: ${id}`)
  if (patch.schedule) parseSchedule(patch.schedule)
  const schedule = patch.schedule ?? cur.schedule
  const enabled = patch.enabled === undefined ? cur.enabled : patch.enabled
  const silence = patch.silenceSec === undefined
    ? (patch.schedule ? silenceWindowSec(schedule) : cur.silence_sec)
    : patch.silenceSec
  const nextAt = !enabled
    ? null
    : (patch.schedule || !cur.next_at ? nextRun(schedule) : cur.next_at)
  d.prepare(`UPDATE jobs SET name=?, goal=?, schedule=?, payload=?, timeout_sec=?, requires_approval=?,
             silence_sec=?, next_at=?, enabled=? WHERE id=?`)
    .run(patch.name ?? cur.name, patch.goal === undefined ? cur.goal : patch.goal, schedule,
      patch.payload ? toJson(patch.payload) : toJson(cur.payload),
      patch.timeoutSec === undefined ? cur.timeout_sec : patch.timeoutSec,
      (patch.requiresApproval === undefined ? cur.requires_approval : patch.requiresApproval) ? 1 : 0,
      silence, nextAt, enabled ? 1 : 0, id)
  return getJob(id)
}

export function getJob (idOrName) {
  const d = open()
  return hydrateJob(d.prepare('SELECT * FROM jobs WHERE id = ? OR name = ?').get(idOrName, idOrName))
}

export function getJobByHeartbeatToken (token) {
  return hydrateJob(open().prepare('SELECT * FROM jobs WHERE heartbeat_token = ?').get(token))
}

export function listJobs ({ includeDisabled = true } = {}) {
  const sql = includeDisabled ? 'SELECT * FROM jobs ORDER BY name' : 'SELECT * FROM jobs WHERE enabled = 1 ORDER BY name'
  return open().prepare(sql).all().map(hydrateJob)
}

export function deleteJob (id) {
  return open().prepare('DELETE FROM jobs WHERE id = ?').run(id).changes
}

export function setNextAt (jobId, at) {
  open().prepare('UPDATE jobs SET next_at = ? WHERE id = ?').run(at, jobId)
}

export function dueJobs (at = now()) {
  return open().prepare('SELECT * FROM jobs WHERE enabled = 1 AND next_at IS NOT NULL AND next_at <= ? ORDER BY next_at')
    .all(at).map(hydrateJob)
}

/* ---------- runs ---------- */

export function createRun ({ jobId, workerId, status = 'queued', trigger = 'schedule' }) {
  const d = open()
  const id = randomUUID()
  d.prepare('INSERT INTO runs (id, job_id, worker_id, trigger, status, queued_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, jobId, workerId, trigger, status, now())
  return getRun(id)
}

export function updateRun (id, patch) {
  const d = open()
  const fields = []
  const values = []
  const map = {
    status: 'status', startedAt: 'started_at', endedAt: 'ended_at', exitCode: 'exit_code',
    costUsd: 'cost_usd', summary: 'summary', stdout: 'stdout', stderr: 'stderr',
  }
  for (const [key, column] of Object.entries(map)) {
    if (patch[key] !== undefined) { fields.push(`${column} = ?`); values.push(patch[key]) }
  }
  if (!fields.length) return getRun(id)
  d.prepare(`UPDATE runs SET ${fields.join(', ')} WHERE id = ?`).run(...values, id)
  return getRun(id)
}

export function getRun (id) {
  return open().prepare('SELECT * FROM runs WHERE id = ?').get(id) ?? null
}

export function listRuns ({ jobId = null, status = null, limit = 50 } = {}) {
  const d = open()
  const where = []
  const args = []
  if (jobId) { where.push('job_id = ?'); args.push(jobId) }
  if (status) { where.push('status = ?'); args.push(status) }
  const sql = `SELECT r.*, j.name AS job_name, w.name AS worker_name FROM runs r
               LEFT JOIN jobs j ON j.id = r.job_id
               LEFT JOIN workers w ON w.id = r.worker_id
               ${where.length ? 'WHERE ' + where.map(w => 'r.' + w).join(' AND ') : ''}
               ORDER BY r.queued_at DESC LIMIT ?`
  return d.prepare(sql).all(...args, limit)
}

export function lastRun (jobId, status = null) {
  const d = open()
  return status
    ? d.prepare('SELECT * FROM runs WHERE job_id = ? AND status = ? ORDER BY queued_at DESC LIMIT 1').get(jobId, status) ?? null
    : d.prepare('SELECT * FROM runs WHERE job_id = ? ORDER BY queued_at DESC LIMIT 1').get(jobId) ?? null
}

export function runningCount () {
  return open().prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'").get().n
}

export function markStaleRunsLost () {
  // A run left in 'running' by a killed scheduler can never finish, so the
  // next start closes it instead of leaving a job blocked for ever.
  const d = open()
  const rows = d.prepare("SELECT id FROM runs WHERE status = 'running'").all()
  if (rows.length) {
    d.prepare("UPDATE runs SET status = 'lost', ended_at = ?, summary = 'the scheduler stopped while this run was open' WHERE status = 'running'").run(now())
  }
  return rows.length
}

export function costSince (ts, { workerId = null } = {}) {
  const d = open()
  const row = workerId
    ? d.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM runs WHERE queued_at >= ? AND worker_id = ?').get(ts, workerId)
    : d.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM runs WHERE queued_at >= ?').get(ts)
  return row.total
}

export function pruneRuns (days) {
  const cutoff = now() - days * 86400 * 1000
  return open().prepare('DELETE FROM runs WHERE queued_at < ?').run(cutoff).changes
}

/* ---------- approvals ---------- */

export function createApproval ({ runId, jobId, question }) {
  const d = open()
  const id = randomUUID()
  d.prepare('INSERT INTO approvals (id, run_id, job_id, state, question, requested_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, runId, jobId, 'pending', question, now())
  return getApproval(id)
}

export function getApproval (id) {
  const d = open()
  return d.prepare(`SELECT a.*, j.name AS job_name FROM approvals a LEFT JOIN jobs j ON j.id = a.job_id
                    WHERE a.id = ? OR a.id LIKE ? LIMIT 1`).get(id, id + '%') ?? null
}

export function listApprovals ({ state = 'pending', limit = 50 } = {}) {
  const d = open()
  const sql = `SELECT a.*, j.name AS job_name FROM approvals a LEFT JOIN jobs j ON j.id = a.job_id
               ${state ? 'WHERE a.state = ?' : ''} ORDER BY a.requested_at DESC LIMIT ?`
  return state ? d.prepare(sql).all(state, limit) : d.prepare(sql).all(limit)
}

export function decideApproval (id, state, { by = 'human', note = null } = {}) {
  const d = open()
  const approval = getApproval(id)
  if (!approval) throw new Error(`no such approval: ${id}`)
  if (approval.state !== 'pending') throw new Error(`approval already ${approval.state}`)
  d.prepare('UPDATE approvals SET state = ?, decided_at = ?, decided_by = ?, note = ? WHERE id = ?')
    .run(state, now(), by, note, approval.id)
  return getApproval(approval.id)
}

/* ---------- events ---------- */

export function addEvent ({ level = 'info', kind, jobId = null, runId = null, message = '' }) {
  open().prepare('INSERT INTO events (at, level, kind, job_id, run_id, message) VALUES (?, ?, ?, ?, ?, ?)')
    .run(now(), level, kind, jobId, runId, message)
}

export function listEvents ({ limit = 100, since = null, level = null } = {}) {
  const d = open()
  const where = []
  const args = []
  if (since) { where.push('at >= ?'); args.push(since) }
  if (level) { where.push('level = ?'); args.push(level) }
  const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY at DESC LIMIT ?`
  return d.prepare(sql).all(...args, limit)
}

/* ---------- heartbeats ---------- */

export function recordHeartbeat (jobId, note = null) {
  open().prepare(`INSERT INTO heartbeats (job_id, last_at, note) VALUES (?, ?, ?)
                  ON CONFLICT(job_id) DO UPDATE SET last_at = excluded.last_at, note = excluded.note`)
    .run(jobId, now(), note)
}

export function getHeartbeat (jobId) {
  return open().prepare('SELECT * FROM heartbeats WHERE job_id = ?').get(jobId) ?? null
}
