import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.SHOPFLOOR_HOME = mkdtempSync(join(tmpdir(), 'shopfloor-test-'))
const home = process.env.SHOPFLOOR_HOME

const db = await import('../src/db.mjs')
const { startJob, budgetState } = await import('../src/runner.mjs')
const { jobHealth, shopHealth } = await import('../src/health.mjs')
const { tick } = await import('../src/scheduler.mjs')
const { buildDigest } = await import('../src/digest.mjs')

before(() => { db.open() })
after(() => { db.close(); rmSync(home, { recursive: true, force: true }) })

test('a job that works leaves an ok run and a next slot', async () => {
  const worker = db.createWorker({ name: 'echo', adapter: 'process', config: { command: 'echo done' } })
  const job = db.createJob({ workerId: worker.id, name: 'echo-job', schedule: 'every 15m' })
  const { run, started } = await startJob(job, { trigger: 'test' })
  assert.equal(started, true)
  assert.equal(run.status, 'ok')
  assert.equal(run.exit_code, 0)
  assert.match(run.stdout, /done/)
  assert.ok(db.getJob(job.id).next_at > Date.now(), 'the next slot is in the future')
})

test('a failing command is recorded as a failure, not as silence', async () => {
  const worker = db.createWorker({ name: 'broken', adapter: 'process', config: { command: 'echo nope >&2; exit 4' } })
  const job = db.createJob({ workerId: worker.id, name: 'broken-job', schedule: 'every 15m' })
  const { run } = await startJob(job, { trigger: 'test' })
  assert.equal(run.status, 'fail')
  assert.equal(run.exit_code, 4)
  assert.match(run.stderr, /nope/)
})

test('a command that runs too long is cut off', async () => {
  const worker = db.createWorker({ name: 'slow', adapter: 'process', config: { command: 'sleep 30' } })
  const job = db.createJob({ workerId: worker.id, name: 'slow-job', schedule: 'manual', timeoutSec: 1 })
  const { run } = await startJob(job, { trigger: 'test' })
  assert.equal(run.status, 'timeout')
})

test('an approval gate holds the run until a human decides', async () => {
  const worker = db.createWorker({ name: 'mailer', adapter: 'process', config: { command: 'echo sent' } })
  const job = db.createJob({ workerId: worker.id, name: 'mail-job', schedule: 'manual', requiresApproval: true })
  const held = await startJob(job, { trigger: 'test' })
  assert.equal(held.started, false)
  assert.equal(held.run.status, 'awaiting_approval')
  assert.equal(db.listApprovals({ state: 'pending' }).length, 1)

  const approval = db.listApprovals({ state: 'pending' })[0]
  db.decideApproval(approval.id, 'approved', { by: 'test' })
  const result = await tick()
  assert.ok(result.started.some((s) => s.trigger === 'approval'), 'the scheduler picks up approved work')
  assert.equal(db.getRun(held.run.id).status, 'ok')
})

test('an approved run cannot be approved twice', () => {
  const approval = db.listApprovals({ state: 'approved' })[0]
  assert.throws(() => db.decideApproval(approval.id, 'approved', { by: 'test' }), /already approved/)
})

test('the day budget blocks a paid worker and lets a free one through', async () => {
  const paid = db.createWorker({ name: 'paid', adapter: 'claude_local', config: { prompt: 'hello' }, maxUsdDay: 0.5 })
  const job = db.createJob({ workerId: paid.id, name: 'paid-job', schedule: 'manual' })
  const spent = db.createRun({ jobId: job.id, workerId: paid.id, status: 'ok' })
  db.updateRun(spent.id, { costUsd: 0.75 })

  const state = budgetState(db.getWorker(paid.id))
  assert.equal(state.workerExceeded, true)
  const { started, blocked } = await startJob(job, { trigger: 'test' })
  assert.equal(started, false)
  assert.match(blocked, /day cap/)

  const free = db.getWorker('echo')
  const freeJob = db.getJob('echo-job')
  const result = await startJob(freeJob, { trigger: 'test' })
  assert.equal(result.started, true, 'a process worker is not stopped by the dollar ceiling')
  void free
})

test('a quiet job is called silent, a young one is not', () => {
  const worker = db.createWorker({ name: 'quiet', adapter: 'process', config: { command: 'echo ok' } })
  const job = db.createJob({ workerId: worker.id, name: 'quiet-job', schedule: 'every 1h', silenceSec: 60 })
  assert.equal(jobHealth(job).state, 'ok', 'a job younger than its own window is not called silent yet')
  const neverRan = jobHealth(job, { at: Date.now() + 5 * 60_000 })
  assert.equal(neverRan.state, 'attention', 'a job that never ran past its window is quiet')

  const run = db.createRun({ jobId: job.id, workerId: worker.id, status: 'ok' })
  db.updateRun(run.id, { endedAt: Date.now() })
  assert.equal(jobHealth(db.getJob(job.id)).state, 'ok')

  const later = Date.now() + 10 * 60_000
  const health = jobHealth(db.getJob(job.id), { at: later })
  assert.equal(health.state, 'attention')
  assert.ok(health.problems.some((p) => p.kind === 'silent'))
})

test('a dead heartbeat is noticed, a fresh one is not', () => {
  const worker = db.createWorker({ name: 'outside', adapter: 'process', config: { command: 'echo ok' } })
  const job = db.createJob({ workerId: worker.id, name: 'outside-job', schedule: 'every 1h', silenceSec: 120 })
  db.recordHeartbeat(job.id, 'launchd said hello')
  const run = db.createRun({ jobId: job.id, workerId: worker.id, status: 'ok' })
  db.updateRun(run.id, { endedAt: Date.now() })
  assert.equal(jobHealth(db.getJob(job.id)).state, 'ok')

  const later = Date.now() + 10 * 60_000
  const problems = jobHealth(db.getJob(job.id), { at: later }).problems.map((p) => p.kind)
  assert.ok(problems.includes('heartbeat'))
})

test('a switched off job is off, not broken', () => {
  const job = db.updateJob(db.getJob('quiet-job').id, { enabled: false })
  assert.equal(job.next_at, null)
  assert.equal(jobHealth(job).state, 'off')
})

test('a run left open by a killed scheduler is closed, not left hanging', () => {
  const worker = db.getWorker('echo')
  const run = db.createRun({ jobId: db.getJob('echo-job').id, workerId: worker.id, status: 'running' })
  assert.equal(db.runningCount(), 1)
  const closed = db.markStaleRunsLost()
  assert.equal(closed, 1)
  assert.equal(db.getRun(run.id).status, 'lost')
  assert.equal(db.runningCount(), 0)
})

test('the digest names what needs attention and what it cost', () => {
  const text = buildDigest()
  assert.match(text, /Shopfloor digest/)
  assert.match(text, /cost/)
  const health = shopHealth()
  if (health.attention.length) assert.match(text, /Needs attention/)
})
