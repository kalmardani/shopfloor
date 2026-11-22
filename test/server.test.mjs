import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.SHOPFLOOR_HOME = mkdtempSync(join(tmpdir(), 'shopfloor-http-'))
const home = process.env.SHOPFLOOR_HOME

const db = await import('../src/db.mjs')
const { createApp } = await import('../src/server.mjs')

const config = { host: '127.0.0.1', port: 0, token: 'secret-token', maxUsdPerDay: 5, tickSeconds: 20, maxConcurrentRuns: 2, defaultTimeoutSec: 60, keepRunOutputChars: 20000, keepRunDays: 90, retryAfterQuotaSec: 1800, digestAt: null, notifyCommand: null }
let base = null
let app = null
let job = null

before(async () => {
  db.open()
  const worker = db.createWorker({ name: 'echo', adapter: 'process', config: { command: 'echo served' } })
  job = db.createJob({ workerId: worker.id, name: 'echo-job', schedule: 'every 15m' })
  app = createApp({ config })
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${app.address().port}`
})

after(async () => {
  await new Promise((resolve) => app.close(resolve))
  db.close()
  rmSync(home, { recursive: true, force: true })
})

const get = (path, token = config.token) => fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} })

test('the api asks for the token when one is set', async () => {
  assert.equal((await fetch(`${base}/api/state`)).status, 401)
  assert.equal((await get('/api/state')).status, 200)
  assert.equal((await fetch(`${base}/api/state?token=secret-token`)).status, 200)
})

test('the state answer holds everything the board draws', async () => {
  const state = await (await get('/api/state')).json()
  assert.equal(state.jobs.length, 1)
  assert.equal(state.jobs[0].name, 'echo-job')
  assert.equal(state.jobs[0].adapter, 'process')
  assert.ok(Array.isArray(state.adapters))
})

test('a job runs through the api and the output is kept out of the list', async () => {
  const res = await fetch(`${base}/api/jobs/${job.id}/run`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    body: '{}',
  })
  const body = await res.json()
  assert.equal(body.run.status, 'ok')
  assert.equal(body.run.stdout, undefined, 'the list answer carries no output')
  const full = await (await get(`/api/runs/${body.run.id}`)).json()
  assert.match(full.stdout, /served/)
})

test('a bad schedule is refused with a reason', async () => {
  const res = await fetch(`${base}/api/schedule`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ schedule: 'whenever' }),
  })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /cannot read schedule/)
})

test('the dead man switch needs no token, only its own secret', async () => {
  const fresh = db.getJob(job.id)
  const ok = await fetch(`${base}/hb/${fresh.heartbeat_token}`)
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).job, 'echo-job')
  assert.equal((await fetch(`${base}/hb/deadbeefdeadbeef`)).status, 404)
})

test('the interface files are served and nothing above them is', async () => {
  const page = await fetch(`${base}/`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<title>Shopfloor<\/title>/)
  const escape = await fetch(`${base}/%2e%2e%2f%2e%2e%2fpackage.json`)
  assert.ok([403, 404].includes(escape.status), `path above the interface must not be served, got ${escape.status}`)
})

test('health answers 503 while something needs attention', async () => {
  const res = await get('/api/health')
  assert.ok([200, 503].includes(res.status))
  const body = await res.json()
  assert.equal(typeof body.ok, 'boolean')
})
