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
  inbox_token TEXT,
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
  note TEXT,
  kind TEXT NOT NULL DEFAULT 'run',
  outbox_id TEXT
);
CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  dedupe_key TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  run_id TEXT,
  parent_run_id TEXT,
  note TEXT,
  wait_until INTEGER,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  settled_at INTEGER
);
CREATE TABLE IF NOT EXISTS memory (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note',
  source TEXT,
  run_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, key)
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
  run_id TEXT,
  channel TEXT NOT NULL,
  recipient TEXT,
  subject TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  dedupe_key TEXT,
  approval_id TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
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
CREATE TABLE IF NOT EXISTS roles (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  spec TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS role_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  run_id TEXT,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS heartbeats (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  last_at INTEGER NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS runs_job_idx ON runs(job_id, queued_at DESC);
CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status);
CREATE INDEX IF NOT EXISTS events_at_idx ON events(at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS inbox_dedupe_idx ON inbox(job_id, dedupe_key);
CREATE INDEX IF NOT EXISTS inbox_status_idx ON inbox(status, created_at);
CREATE INDEX IF NOT EXISTS outbox_status_idx ON outbox(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS outbox_dedupe_idx ON outbox(job_id, dedupe_key);
CREATE INDEX IF NOT EXISTS role_snapshots_idx ON role_snapshots(job_id, at DESC);
`

// CREATE TABLE IF NOT EXISTS leaves an older database without the columns that
// arrived later, so every new column is also added here, once, on open.
const MIGRATIONS = [
  ['approvals', 'kind', "TEXT NOT NULL DEFAULT 'run'"],
  ['approvals', 'outbox_id', 'TEXT'],
  ['jobs', 'inbox_token', 'TEXT'],
]

let db = null

export function open () {
  if (db) return db
  ensureHome()
  db = new DatabaseSync(DB_PATH)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(SCHEMA)
  migrate(db)
  return db
}

function migrate (d) {
  for (const [table, column, definition] of MIGRATIONS) {
    const columns = d.prepare(`PRAGMA table_info(${table})`).all()
    if (columns.some((c) => c.name === column)) continue
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
  for (const row of d.prepare('SELECT id FROM jobs WHERE inbox_token IS NULL').all()) {
    d.prepare('UPDATE jobs SET inbox_token = ? WHERE id = ?').run(randomUUID().replaceAll('-', ''), row.id)
  }
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
             silence_sec, heartbeat_token, inbox_token, next_at, enabled, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, worker.id, name, goal, schedule, toJson(payload), timeoutSec, requiresApproval ? 1 : 0,
      silence, randomUUID().replaceAll('-', ''), randomUUID().replaceAll('-', ''),
      enabled ? nextRun(schedule) : null, enabled ? 1 : 0, now())
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

export function getJobByInboxToken (token) {
  return hydrateJob(open().prepare('SELECT * FROM jobs WHERE inbox_token = ?').get(token))
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

export function createApproval ({ runId, jobId, question, kind = 'run', outboxId = null }) {
  const d = open()
  const id = randomUUID()
  d.prepare(`INSERT INTO approvals (id, run_id, job_id, state, question, requested_at, kind, outbox_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, runId, jobId, 'pending', question, now(), kind, outboxId)
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

/* ---------- inbox ---------- */

function hydrateInbox (row) {
  if (!row) return null
  return { ...row, payload: parse(row.payload) }
}

// Every new piece of work arrives here, whatever brought it: a message typed
// at the command line, a webhook, the timer, or the answer of an earlier run.
// A dedupe key is the promise that the same event never starts two runs, which
// is why the unique index carries it rather than the code checking first.
export function addInboxEvent ({ jobId, source = 'message', payload = {}, dedupeKey = null,
  parentRunId = null, note = null, waitUntil = null }) {
  const d = open()
  if (dedupeKey) {
    const seen = d.prepare('SELECT * FROM inbox WHERE job_id = ? AND dedupe_key = ?').get(jobId, dedupeKey)
    if (seen) return { event: hydrateInbox(seen), duplicate: true }
  }
  const id = randomUUID()
  d.prepare(`INSERT INTO inbox (id, job_id, source, dedupe_key, payload, status, parent_run_id, note, wait_until, created_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
    .run(id, jobId, source, dedupeKey, toJson(payload), parentRunId, note, waitUntil, now())
  return { event: getInboxEvent(id), duplicate: false }
}

export function getInboxEvent (id) {
  const d = open()
  return hydrateInbox(d.prepare('SELECT * FROM inbox WHERE id = ? OR id LIKE ? LIMIT 1').get(id, id + '%'))
}

export function listInbox ({ jobId = null, status = null, limit = 50 } = {}) {
  const d = open()
  const where = []
  const args = []
  if (jobId) { where.push('i.job_id = ?'); args.push(jobId) }
  if (status) { where.push('i.status = ?'); args.push(status) }
  const sql = `SELECT i.*, j.name AS job_name FROM inbox i LEFT JOIN jobs j ON j.id = i.job_id
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.created_at DESC LIMIT ?`
  return d.prepare(sql).all(...args, limit).map(hydrateInbox)
}

export function inboxCounts () {
  const rows = open().prepare('SELECT status, COUNT(*) AS n FROM inbox GROUP BY status').all()
  const counts = { pending: 0, claimed: 0, done: 0, dropped: 0 }
  for (const row of rows) counts[row.status] = row.n
  return counts
}

// Jobs with something waiting, oldest event first, skipping the ones that were
// asked to wait after a ceiling or a hit quota.
export function jobsWithPendingInbox (at = now()) {
  return open().prepare(`SELECT i.job_id AS job_id, MIN(i.created_at) AS oldest FROM inbox i
                         JOIN jobs j ON j.id = i.job_id
                         WHERE i.status = 'pending' AND j.enabled = 1
                           AND (i.wait_until IS NULL OR i.wait_until <= ?)
                         GROUP BY i.job_id ORDER BY oldest`).all(at).map((r) => r.job_id)
}

// One inbox, one worker. A claim is refused while an earlier event of the same
// job is still open, so two ticks can never work the same inbox at once.
export function claimInboxEvent (jobId, { at = now() } = {}) {
  const d = open()
  const busy = d.prepare("SELECT id FROM inbox WHERE job_id = ? AND status = 'claimed' LIMIT 1").get(jobId)
  if (busy) return null
  const row = d.prepare(`SELECT * FROM inbox WHERE job_id = ? AND status = 'pending'
                         AND (wait_until IS NULL OR wait_until <= ?)
                         ORDER BY created_at LIMIT 1`).get(jobId, at)
  if (!row) return null
  d.prepare("UPDATE inbox SET status = 'claimed', claimed_at = ? WHERE id = ? AND status = 'pending'").run(at, row.id)
  const claimed = getInboxEvent(row.id)
  return claimed?.status === 'claimed' ? claimed : null
}

export function settleInboxEvent (id, status, { runId = undefined, note = undefined, waitUntil = null } = {}) {
  const d = open()
  const event = getInboxEvent(id)
  if (!event) throw new Error(`no such inbox event: ${id}`)
  d.prepare('UPDATE inbox SET status = ?, run_id = ?, note = ?, wait_until = ?, settled_at = ? WHERE id = ?')
    .run(status, runId === undefined ? event.run_id : runId, note === undefined ? event.note : note,
      waitUntil, status === 'pending' || status === 'claimed' ? null : now(), event.id)
  return getInboxEvent(event.id)
}

export function attachInboxRun (id, runId) {
  open().prepare('UPDATE inbox SET run_id = ? WHERE id = ?').run(runId, id)
  return getInboxEvent(id)
}

export function inboxEventForRun (runId) {
  return hydrateInbox(open().prepare('SELECT * FROM inbox WHERE run_id = ? LIMIT 1').get(runId))
}

// A scheduler killed mid run leaves a claim nobody holds any more. The next
// start hands those events back, except the ones parked in front of a human.
export function releaseClaimedInboxEvents () {
  const d = open()
  const rows = d.prepare(`SELECT i.id FROM inbox i LEFT JOIN runs r ON r.id = i.run_id
                          WHERE i.status = 'claimed'
                            AND (r.id IS NULL OR r.status NOT IN ('awaiting_approval', 'running'))`).all()
  for (const row of rows) {
    d.prepare("UPDATE inbox SET status = 'pending', claimed_at = NULL WHERE id = ?").run(row.id)
  }
  return rows.length
}

export function pruneInbox (days) {
  const cutoff = now() - days * 86400 * 1000
  return open().prepare("DELETE FROM inbox WHERE created_at < ? AND status IN ('done', 'dropped')").run(cutoff).changes
}

/* ---------- memory ---------- */

// Memory lives beside the job, not inside the run, so a crashed agent loses
// nothing and a replaced agent starts where the last one stopped. Provenance
// is on every row, because a memory that can be written can be poisoned.
export function setMemory ({ jobId, key, value, kind = 'note', source = null, runId = null }) {
  const d = open()
  d.prepare(`INSERT INTO memory (job_id, key, value, kind, source, run_id, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(job_id, key) DO UPDATE SET value = excluded.value, kind = excluded.kind,
               source = excluded.source, run_id = excluded.run_id, updated_at = excluded.updated_at`)
    .run(jobId, key, String(value), kind, source, runId, now())
  return getMemory(jobId, key)
}

export function getMemory (jobId, key) {
  return open().prepare('SELECT * FROM memory WHERE job_id = ? AND key = ?').get(jobId, key) ?? null
}

export function listMemory (jobId) {
  return open().prepare('SELECT * FROM memory WHERE job_id = ? ORDER BY key').all(jobId)
}

export function deleteMemory (jobId, key) {
  return open().prepare('DELETE FROM memory WHERE job_id = ? AND key = ?').run(jobId, key).changes
}

export function memoryCount (jobId = null) {
  return jobId
    ? open().prepare('SELECT COUNT(*) AS n FROM memory WHERE job_id = ?').get(jobId).n
    : open().prepare('SELECT COUNT(*) AS n FROM memory').get().n
}

/* ---------- outbox ---------- */

// Finished work waits here instead of leaving on its own. The shop floor starts
// quiet, so a pending entry is the normal state and sending is a decision.
export function addOutboxEntry ({ jobId = null, runId = null, channel, recipient = null, subject = null,
  body, status = 'pending', dedupeKey = null, note = null }) {
  const d = open()
  if (dedupeKey) {
    const seen = d.prepare('SELECT * FROM outbox WHERE job_id IS ? AND dedupe_key = ?').get(jobId, dedupeKey)
    if (seen) return { entry: seen, duplicate: true }
  }
  const id = randomUUID()
  d.prepare(`INSERT INTO outbox (id, job_id, run_id, channel, recipient, subject, body, status, dedupe_key, note, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, jobId, runId, channel, recipient, subject, String(body), status, dedupeKey, note, now())
  return { entry: getOutboxEntry(id), duplicate: false }
}

export function getOutboxEntry (id) {
  const d = open()
  return d.prepare(`SELECT o.*, j.name AS job_name FROM outbox o LEFT JOIN jobs j ON j.id = o.job_id
                    WHERE o.id = ? OR o.id LIKE ? LIMIT 1`).get(id, id + '%') ?? null
}

export function listOutbox ({ jobId = null, status = null, limit = 50 } = {}) {
  const d = open()
  const where = []
  const args = []
  if (jobId) { where.push('o.job_id = ?'); args.push(jobId) }
  if (status) { where.push('o.status = ?'); args.push(status) }
  const sql = `SELECT o.*, j.name AS job_name FROM outbox o LEFT JOIN jobs j ON j.id = o.job_id
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.created_at LIMIT ?`
  return d.prepare(sql).all(...args, limit)
}

export function outboxCounts () {
  const rows = open().prepare('SELECT status, COUNT(*) AS n FROM outbox GROUP BY status').all()
  const counts = { pending: 0, sent: 0, held: 0 }
  for (const row of rows) counts[row.status] = row.n
  return counts
}

export function updateOutboxEntry (id, patch) {
  const d = open()
  const entry = getOutboxEntry(id)
  if (!entry) throw new Error(`no such outbox entry: ${id}`)
  const fields = []
  const values = []
  const map = { status: 'status', note: 'note', sentAt: 'sent_at', approvalId: 'approval_id' }
  for (const [key, column] of Object.entries(map)) {
    if (patch[key] !== undefined) { fields.push(`${column} = ?`); values.push(patch[key]) }
  }
  if (!fields.length) return entry
  d.prepare(`UPDATE outbox SET ${fields.join(', ')} WHERE id = ?`).run(...values, entry.id)
  return getOutboxEntry(entry.id)
}

export function lastOutboxSentAt () {
  return open().prepare("SELECT MAX(sent_at) AS at FROM outbox WHERE status = 'sent'").get().at ?? null
}

export function pruneOutbox (days) {
  const cutoff = now() - days * 86400 * 1000
  return open().prepare("DELETE FROM outbox WHERE created_at < ? AND status = 'sent'").run(cutoff).changes
}


/* ---------- roles ---------- */

// The job ad is kept as written, next to the spec read from it, so what the
// agent was told and what the shop floor enforced can always be compared.
export function setRole ({ jobId, source, spec }) {
  const d = open()
  const cur = getRole(jobId)
  d.prepare(`INSERT INTO roles (job_id, source, spec, version, updated_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(job_id) DO UPDATE SET source = excluded.source, spec = excluded.spec,
               version = excluded.version, updated_at = excluded.updated_at`)
    .run(jobId, String(source), toJson(spec), cur ? cur.version + 1 : 1, now())
  return getRole(jobId)
}

export function getRole (jobId) {
  const row = open().prepare('SELECT * FROM roles WHERE job_id = ?').get(jobId)
  return row ? { ...row, spec: parse(row.spec) } : null
}

export function listRoles () {
  return open().prepare(`SELECT r.*, j.name AS job_name, j.enabled AS job_enabled FROM roles r
                         JOIN jobs j ON j.id = r.job_id ORDER BY j.name`).all()
    .map((row) => ({ ...row, spec: parse(row.spec), job_enabled: !!row.job_enabled }))
}

export function addRoleSnapshot ({ jobId, runId = null, ok = false, data, at = now() }) {
  open().prepare('INSERT INTO role_snapshots (job_id, run_id, at, ok, data) VALUES (?, ?, ?, ?, ?)')
    .run(jobId, runId, at, ok ? 1 : 0, toJson(data))
}

export function listRoleSnapshots (jobId, { since = 0, until = Number.MAX_SAFE_INTEGER, onlyOk = false } = {}) {
  return open().prepare(`SELECT * FROM role_snapshots WHERE job_id = ? AND at >= ? AND at <= ? ${onlyOk ? 'AND ok = 1' : ''}
                         ORDER BY at`).all(jobId, since, until)
    .map((row) => ({ ...row, ok: !!row.ok, data: parse(row.data) }))
}

export function pruneRoleSnapshots (days) {
  const cutoff = now() - days * 86400 * 1000
  return open().prepare('DELETE FROM role_snapshots WHERE at < ?').run(cutoff).changes
}

// What one job put in the outbox inside a window, with the decision on each.
export function outboxWithDecisions (jobId, { since = 0, until = Number.MAX_SAFE_INTEGER } = {}) {
  return open().prepare(`SELECT o.*, a.state AS decision, a.note AS decision_note, a.decided_at AS decided_at
                         FROM outbox o LEFT JOIN approvals a ON a.id = o.approval_id
                         WHERE o.job_id = ? AND o.created_at >= ? AND o.created_at <= ?
                         ORDER BY o.created_at`).all(jobId, since, until)
}

// Decisions taken inside a window, on outbox entries of one job, whenever the
// entry itself was made. A proposal from last week approved on Monday counts.
export function decisionsFor (jobId, { since = 0, until = Number.MAX_SAFE_INTEGER } = {}) {
  return open().prepare(`SELECT a.*, o.subject AS subject, o.created_at AS made_at FROM approvals a
                         LEFT JOIN outbox o ON o.id = a.outbox_id
                         WHERE a.job_id = ? AND a.kind = 'outbox' AND a.decided_at >= ? AND a.decided_at <= ?
                         ORDER BY a.decided_at`).all(jobId, since, until)
}

export function eventsFor (jobId, { kinds = [], since = 0, until = Number.MAX_SAFE_INTEGER } = {}) {
  const d = open()
  const filter = kinds.length ? `AND kind IN (${kinds.map(() => '?').join(', ')})` : ''
  return d.prepare(`SELECT * FROM events WHERE job_id IS ? AND at >= ? AND at <= ? ${filter} ORDER BY at`)
    .all(jobId, since, until, ...kinds)
}
