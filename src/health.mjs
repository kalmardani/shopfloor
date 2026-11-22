import * as db from './db.mjs'
import { loadConfig } from './config.mjs'

// The question this whole program exists to answer: what stopped without
// telling anyone?
//
// Four ways a job goes quiet.
//   silent      no finished run inside its own silence window
//   stale       its next slot is well in the past, so the scheduler is not running
//   failing     the last two runs or more ended badly
//   heartbeat   an outside process stopped pinging its dead man's switch
export function jobHealth (job, { at = Date.now() } = {}) {
  const last = db.lastRun(job.id)
  const lastOk = db.lastRun(job.id, 'ok')
  const recent = db.listRuns({ jobId: job.id, limit: 3 })
  const heartbeat = db.getHeartbeat(job.id)
  const problems = []

  const window = job.silence_sec
  const reference = lastOk?.ended_at ?? lastOk?.queued_at ?? job.created_at
  if (job.enabled && window && at - reference > window * 1000) {
    problems.push({
      kind: 'silent',
      message: `no finished run for ${humanAge(at - reference)}, the window is ${humanAge(window * 1000)}`,
    })
  }

  if (job.enabled && job.next_at && at - job.next_at > Math.max(5 * 60_000, (loadConfig().tickSeconds || 20) * 10_000)) {
    problems.push({ kind: 'stale', message: `its slot passed ${humanAge(at - job.next_at)} ago and nothing picked it up` })
  }

  const bad = recent.filter((r) => ['fail', 'timeout', 'lost'].includes(r.status))
  if (recent.length >= 2 && bad.length >= 2) {
    problems.push({ kind: 'failing', message: `${bad.length} of the last ${recent.length} runs ended in ${bad[0].status}` })
  }

  if (heartbeat && window && at - heartbeat.last_at > window * 1000) {
    problems.push({ kind: 'heartbeat', message: `the outside process stopped pinging ${humanAge(at - heartbeat.last_at)} ago` })
  }

  return {
    job,
    state: problems.length === 0 ? (job.enabled ? 'ok' : 'off') : 'attention',
    problems,
    lastRun: last,
    lastOkAt: lastOk?.ended_at ?? null,
    heartbeatAt: heartbeat?.last_at ?? null,
  }
}

export function shopHealth ({ at = Date.now() } = {}) {
  const jobs = db.listJobs()
  const health = jobs.map((job) => jobHealth(job, { at }))
  return {
    at,
    jobs: health,
    attention: health.filter((h) => h.state === 'attention'),
    pendingApprovals: db.listApprovals({ state: 'pending' }),
    running: db.listRuns({ status: 'running', limit: 20 }),
    spentToday: db.costSince(startOfToday()),
  }
}

export function humanAge (ms) {
  const s = Math.round(Math.abs(ms) / 1000)
  if (s < 90) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 90) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

export function startOfToday () {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
