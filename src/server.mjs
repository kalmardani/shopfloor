import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, dirname, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as db from './db.mjs'
import { loadConfig, saveConfig } from './config.mjs'
import { startJob, runApproved, budgetState } from './runner.mjs'
import { shopHealth } from './health.mjs'
import { buildDigest } from './digest.mjs'
import { adapterNames } from './adapters/index.mjs'
import { parseSchedule, nextRun } from './schedule.mjs'

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), 'ui')
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' }

export function createApp ({ config = loadConfig() } = {}) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const path = url.pathname
    try {
      // The dead man's switch. Its own secret is the key, so a script on
      // another machine can ping it with one curl and no other setup.
      const hb = path.match(/^\/hb\/([a-f0-9]{8,})$/)
      if (hb) {
        const job = db.getJobByHeartbeatToken(hb[1])
        if (!job) return send(res, 404, { error: 'unknown heartbeat token' })
        db.recordHeartbeat(job.id, url.searchParams.get('note'))
        return send(res, 200, { ok: true, job: job.name })
      }

      if (path.startsWith('/api/')) {
        if (config.token && !authorised(req, url, config.token)) return send(res, 401, { error: 'token required' })
        return await api(req, res, { path, url, config })
      }

      return await serveStatic(res, path)
    } catch (err) {
      send(res, 500, { error: String(err?.message || err) })
    }
  })
}

function authorised (req, url, token) {
  const header = req.headers.authorization || ''
  return header === `Bearer ${token}` || url.searchParams.get('token') === token
}

async function api (req, res, { path, url, config }) {
  const method = req.method
  const segments = path.replace(/^\/api\//, '').split('/').filter(Boolean)
  const [section, id, action] = segments
  const body = ['POST', 'PATCH', 'PUT'].includes(method) ? await readJsonBody(req) : {}

  if (section === 'state' && method === 'GET') {
    const health = shopHealth()
    return send(res, 200, {
      at: Date.now(),
      config: { maxUsdPerDay: config.maxUsdPerDay, tickSeconds: config.tickSeconds, maxConcurrentRuns: config.maxConcurrentRuns, digestAt: config.digestAt },
      spentToday: health.spentToday,
      jobs: health.jobs.map((h) => ({
        ...h.job,
        worker: db.getWorker(h.job.worker_id)?.name || null,
        adapter: db.getWorker(h.job.worker_id)?.adapter || null,
        state: h.state,
        problems: h.problems,
        lastRun: h.lastRun && { id: h.lastRun.id, status: h.lastRun.status, at: h.lastRun.queued_at, cost: h.lastRun.cost_usd, summary: h.lastRun.summary },
        heartbeatAt: h.heartbeatAt,
      })),
      workers: db.listWorkers().map((w) => ({ ...w, budget: budgetState(w, config) })),
      approvals: db.listApprovals({ state: 'pending' }),
      runs: db.listRuns({ limit: 40 }).map(stripOutput),
      events: db.listEvents({ limit: 40 }),
      adapters: adapterNames,
    })
  }

  if (section === 'workers') {
    if (method === 'GET') return send(res, 200, db.listWorkers())
    if (method === 'POST') return send(res, 201, db.createWorker(body))
    if (method === 'PATCH' && id) return send(res, 200, db.updateWorker(db.getWorker(id).id, body))
    if (method === 'DELETE' && id) return send(res, 200, { deleted: db.deleteWorker(db.getWorker(id).id) })
  }

  if (section === 'jobs') {
    if (method === 'GET' && !id) return send(res, 200, db.listJobs())
    if (method === 'GET' && id) return send(res, 200, db.getJob(id))
    if (method === 'POST' && !id) return send(res, 201, db.createJob(body))
    if (method === 'POST' && id && action === 'run') {
      const outcome = await startJob(db.getJob(id), { trigger: 'manual', force: !!body.force, config })
      return send(res, 200, { run: stripOutput(outcome.run), started: outcome.started, approval: outcome.approval || null, blocked: outcome.blocked || null })
    }
    if (method === 'PATCH' && id) return send(res, 200, db.updateJob(db.getJob(id).id, body))
    if (method === 'DELETE' && id) return send(res, 200, { deleted: db.deleteJob(db.getJob(id).id) })
  }

  if (section === 'runs') {
    if (method === 'GET' && !id) {
      return send(res, 200, db.listRuns({
        jobId: url.searchParams.get('job') ? db.getJob(url.searchParams.get('job'))?.id : null,
        status: url.searchParams.get('status'),
        limit: Number(url.searchParams.get('limit') || 50),
      }).map(stripOutput))
    }
    if (method === 'GET' && id) return send(res, 200, db.getRun(id))
  }

  if (section === 'approvals') {
    if (method === 'GET') return send(res, 200, db.listApprovals({ state: url.searchParams.get('state') || 'pending' }))
    if (method === 'POST' && id && (action === 'approve' || action === 'reject')) {
      const approval = db.decideApproval(id, action === 'approve' ? 'approved' : 'rejected', { by: body.by || 'web', note: body.note || null })
      db.addEvent({ level: 'info', kind: `approval:${approval.state}`, jobId: approval.job_id, runId: approval.run_id, message: body.note || approval.state })
      if (approval.state === 'approved' && body.now !== false) {
        const run = await runApproved(approval.id, { config })
        return send(res, 200, { approval, run: stripOutput(run) })
      }
      if (approval.state === 'rejected') {
        db.updateRun(approval.run_id, { status: 'rejected', endedAt: Date.now(), summary: body.note || 'rejected by a human' })
      }
      return send(res, 200, { approval })
    }
  }

  if (section === 'events' && method === 'GET') return send(res, 200, db.listEvents({ limit: Number(url.searchParams.get('limit') || 100) }))
  if (section === 'digest' && method === 'GET') return send(res, 200, { text: buildDigest({ hours: Number(url.searchParams.get('hours') || 24) }) })
  if (section === 'health' && method === 'GET') {
    const health = shopHealth()
    return send(res, health.attention.length ? 503 : 200, {
      ok: health.attention.length === 0,
      attention: health.attention.map((h) => ({ job: h.job.name, problems: h.problems })),
    })
  }
  if (section === 'schedule' && method === 'POST') {
    try {
      const parsed = parseSchedule(body.schedule)
      return send(res, 200, { ok: true, kind: parsed.kind, next: nextRun(parsed) })
    } catch (err) { return send(res, 400, { ok: false, error: err.message }) }
  }
  if (section === 'config') {
    if (method === 'GET') return send(res, 200, loadConfig())
    if (method === 'PATCH') return send(res, 200, saveConfig(body))
  }

  return send(res, 404, { error: `no such endpoint: ${method} ${path}` })
}

function stripOutput (run) {
  if (!run) return run
  const { stdout, stderr, ...rest } = run
  return { ...rest, hasOutput: !!(stdout || stderr) }
}

function send (res, status, payload) {
  const text = JSON.stringify(payload, null, 2)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

async function readJsonBody (req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 2_000_000) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('request body is not valid JSON') }
}

async function serveStatic (res, path) {
  const file = path === '/' || path === '' ? 'index.html' : path.replace(/^\//, '')
  const resolved = join(UI_DIR, normalize(file))
  if (!resolved.startsWith(UI_DIR)) { res.writeHead(403); res.end('no'); return }
  try {
    const data = await readFile(resolved)
    res.writeHead(200, { 'content-type': MIME[extname(resolved)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(data)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }
}

export function serve ({ config = loadConfig(), log = console.log } = {}) {
  const app = createApp({ config })
  return new Promise((resolve) => {
    app.listen(config.port, config.host, () => {
      log(`shopfloor is on http://${config.host}:${config.port}${config.token ? '?token=' + config.token : ''}`)
      resolve(app)
    })
  })
}
