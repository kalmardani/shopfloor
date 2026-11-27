import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.SHOPFLOOR_HOME = mkdtempSync(join(tmpdir(), 'shopfloor-queues-'))
const home = process.env.SHOPFLOOR_HOME

const db = await import('../src/db.mjs')
const { startJob, runApproved } = await import('../src/runner.mjs')
const { tick } = await import('../src/scheduler.mjs')
const { dispatchOutbox, sendOne, retryOutbox } = await import('../src/outbox.mjs')
const { memoryBlock } = await import('../src/memory.mjs')

before(() => { db.open() })
after(() => { db.close(); rmSync(home, { recursive: true, force: true }) })

test('an event in the inbox starts a run and the payload reaches the work', async () => {
  const worker = db.createWorker({ name: 'reader', adapter: 'process', config: { command: 'printf "%s" "$SHOPFLOOR_EVENT"' } })
  const job = db.createJob({ workerId: worker.id, name: 'reader-job', schedule: 'every 1h' })
  const slotBefore = db.getJob(job.id).next_at

  const { event, duplicate } = db.addInboxEvent({ jobId: job.id, source: 'message', payload: { message: 'a new file landed' }, dedupeKey: 'file-1' })
  assert.equal(duplicate, false)
  assert.equal(event.status, 'pending')

  const result = await tick()
  assert.ok(result.started.some((s) => s.trigger === 'inbox'), 'the tick picks up what arrived')
  const settled = db.getInboxEvent(event.id)
  assert.equal(settled.status, 'done')
  const run = db.getRun(settled.run_id)
  assert.equal(run.status, 'ok')
  assert.match(run.stdout, /a new file landed/)
  assert.equal(db.getJob(job.id).next_at, slotBefore, 'an event driven run leaves the timer alone')
})

test('the same event never starts two runs', async () => {
  const job = db.getJob('reader-job')
  const again = db.addInboxEvent({ jobId: job.id, source: 'message', payload: { message: 'a new file landed' }, dedupeKey: 'file-1' })
  assert.equal(again.duplicate, true)
  const before = db.listRuns({ jobId: job.id, limit: 50 }).length
  await tick()
  assert.equal(db.listRuns({ jobId: job.id, limit: 50 }).length, before, 'nothing ran a second time')
})

test('one inbox has one worker', () => {
  const job = db.getJob('reader-job')
  db.addInboxEvent({ jobId: job.id, source: 'message', payload: { message: 'first' }, dedupeKey: 'one' })
  db.addInboxEvent({ jobId: job.id, source: 'message', payload: { message: 'second' }, dedupeKey: 'two' })
  const claimed = db.claimInboxEvent(job.id)
  assert.equal(claimed.payload.message, 'first', 'the oldest event goes first')
  assert.equal(db.claimInboxEvent(job.id), null, 'a second worker is refused while the first holds the inbox')

  db.settleInboxEvent(claimed.id, 'done', { note: 'test' })
  const next = db.claimInboxEvent(job.id)
  assert.equal(next.payload.message, 'second')
  db.settleInboxEvent(next.id, 'done', { note: 'test' })
})

test('a claim that nobody holds any more is handed back', () => {
  const job = db.getJob('reader-job')
  const { event } = db.addInboxEvent({ jobId: job.id, source: 'message', payload: { message: 'orphan' }, dedupeKey: 'orphan' })
  db.claimInboxEvent(job.id)
  assert.equal(db.getInboxEvent(event.id).status, 'claimed')
  assert.equal(db.releaseClaimedInboxEvents(), 1)
  assert.equal(db.getInboxEvent(event.id).status, 'pending')
  db.settleInboxEvent(event.id, 'dropped', { note: 'test' })
})

test('the timer writes its firing into the inbox, once per slot', async () => {
  const worker = db.createWorker({ name: 'ticker', adapter: 'process', config: { command: 'echo fired' } })
  const job = db.createJob({ workerId: worker.id, name: 'ticker-job', schedule: 'every 15m' })
  db.setNextAt(job.id, Date.now() - 1000)
  const slot = db.getJob(job.id).next_at

  await tick()
  const timers = db.listInbox({ jobId: job.id, limit: 10 })
  assert.equal(timers.length, 1)
  assert.equal(timers[0].source, 'timer')
  assert.equal(timers[0].status, 'done')
  assert.equal(db.getRun(timers[0].run_id).status, 'ok')

  const second = db.addInboxEvent({ jobId: job.id, source: 'timer', dedupeKey: `timer:${slot}` })
  assert.equal(second.duplicate, true, 'the slot is the dedupe key, so two schedulers cannot fire it twice')
})

test('a run reads the memory of its job and writes it back', async () => {
  const worker = db.createWorker({ name: 'rememberer', adapter: 'process', config: { command: 'echo "::memory last_seen = 4812"' } })
  const job = db.createJob({ workerId: worker.id, name: 'memory-job', schedule: 'manual' })
  await startJob(job, { trigger: 'test' })

  const row = db.getMemory(job.id, 'last_seen')
  assert.equal(row.value, '4812')
  assert.equal(row.kind, 'note')
  assert.equal(row.source, 'run')
  assert.ok(row.run_id, 'provenance names the run that wrote it')

  assert.match(memoryBlock(db.getJob(job.id)), /last_seen = 4812/)

  db.updateWorker(worker.id, { config: { command: 'printf "%s" "$SHOPFLOOR_MEMORY"' } })
  const { run } = await startJob(db.getJob(job.id), { trigger: 'test' })
  assert.match(run.stdout, /last_seen = 4812/, 'the next run starts with what the job knows')
  assert.equal(db.listMemory(job.id).length, 1, 'the memory block in the output is prose, not an instruction')
})

test('a long memory value is cut instead of filling the store', async () => {
  const worker = db.createWorker({ name: 'flooder', adapter: 'process', config: { command: `echo "::memory wall = $(printf 'x%.0s' $(seq 1 3000))"` } })
  const job = db.createJob({ workerId: worker.id, name: 'flooder-job', schedule: 'manual' })
  await startJob(job, { trigger: 'test' })
  assert.equal(db.getMemory(job.id, 'wall').value.length, 2000)
})

test('a run leaves work in the outbox and the shop floor stays quiet', async () => {
  const worker = db.createWorker({
    name: 'writer',
    adapter: 'process',
    config: { command: 'printf "%s\\n" "::outbox channel=email to=dani@example.com subject=Weekly key=week-48" "Dear Dani," "the week went well." "::end"' },
  })
  const job = db.createJob({ workerId: worker.id, name: 'letter-job', schedule: 'manual' })
  await startJob(job, { trigger: 'test' })

  const entries = db.listOutbox({ jobId: job.id })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].status, 'pending')
  assert.equal(entries[0].recipient, 'dani@example.com')
  assert.match(entries[0].body, /the week went well/)

  const quiet = await dispatchOutbox()
  assert.equal(quiet.silent, true, 'nothing leaves the machine by default')
  assert.match(quiet.reason, /outboxSend/)
  assert.equal(db.getOutboxEntry(entries[0].id).status, 'pending')

  // The same run again writes nothing new, because the entry carries a key.
  await startJob(db.getJob(job.id), { trigger: 'test' })
  assert.equal(db.listOutbox({ jobId: job.id }).length, 1)
})

test('sending asks the approval gate that is already here', async () => {
  const carried = join(home, 'carried.txt')
  const config = {
    outboxSend: true,
    outboxCommand: `cat >> ${carried}`,
    outboxRequiresApproval: true,
    outboxPerTick: 5,
    outboxMinGapSec: 0,
    outboxTimeoutSec: 30,
    keepRunOutputChars: 20000,
  }
  const entry = db.listOutbox({ jobId: db.getJob('letter-job').id })[0]

  const first = await dispatchOutbox({ config })
  assert.deepEqual(first.sent, [], 'the first pass only asks')
  const held = db.getOutboxEntry(entry.id)
  assert.equal(held.status, 'held')
  assert.ok(held.approval_id, 'the entry points at the decision it waits for')
  const approval = db.getApproval(held.approval_id)
  assert.equal(approval.kind, 'outbox')
  assert.equal(approval.state, 'pending')
  assert.ok(db.listApprovals({ state: 'pending' }).some((a) => a.id === approval.id), 'it waits in the same queue as a job')
  assert.equal(existsSync(carried), false)

  db.decideApproval(approval.id, 'approved', { by: 'test' })
  const second = await dispatchOutbox({ config })
  assert.deepEqual(second.sent, [entry.id])
  assert.equal(db.getOutboxEntry(entry.id).status, 'sent')
  assert.match(readFileSync(carried, 'utf8'), /the week went well/)

  const third = await dispatchOutbox({ config })
  assert.deepEqual(third.sent, [], 'a sent entry is not carried twice')
})

test('a rejected decision keeps the entry in the building', async () => {
  const config = { outboxSend: true, outboxCommand: 'cat > /dev/null', outboxRequiresApproval: true, outboxPerTick: 5, outboxMinGapSec: 0 }
  const job = db.getJob('letter-job')
  const run = db.lastRun(job.id, 'ok')
  const { entry } = db.addOutboxEntry({ jobId: job.id, runId: run.id, channel: 'email', recipient: 'nobody@example.com', body: 'a letter nobody wants', dedupeKey: 'rejected-one' })

  await dispatchOutbox({ config })
  const held = db.getOutboxEntry(entry.id)
  db.decideApproval(held.approval_id, 'rejected', { by: 'test', note: 'not this week' })
  const after = await dispatchOutbox({ config })
  assert.deepEqual(after.sent, [])
  assert.equal(db.getOutboxEntry(entry.id).status, 'held')
})

test('sending is paced, so one run does not post twenty messages at once', async () => {
  const config = { outboxSend: true, outboxCommand: 'cat > /dev/null', outboxRequiresApproval: false, outboxPerTick: 1, outboxMinGapSec: 0 }
  const job = db.getJob('letter-job')
  for (const n of [1, 2, 3]) {
    db.addOutboxEntry({ jobId: job.id, channel: 'note', body: `message ${n}`, dedupeKey: `paced-${n}` })
  }
  const first = await dispatchOutbox({ config })
  assert.equal(first.sent.length, 1)
  assert.ok(first.waiting.length >= 2, 'the rest waits for the next pass')
  const second = await dispatchOutbox({ config })
  assert.equal(second.sent.length, 1)
  assert.equal(db.outboxCounts().sent, 3, 'one letter went out earlier, two more now')
})

test('a failed delivery is held with its reason and never retries on its own', async () => {
  const config = { outboxSend: true, outboxCommand: 'echo "the carrier is down" >&2; exit 3', outboxRequiresApproval: false, outboxPerTick: 5, outboxMinGapSec: 0 }
  const { entry } = db.addOutboxEntry({ jobId: db.getJob('letter-job').id, channel: 'note', body: 'goes nowhere', dedupeKey: 'broken-one' })
  await dispatchOutbox({ config })
  const held = db.getOutboxEntry(entry.id)
  assert.equal(held.status, 'held')
  assert.match(held.note, /carrier is down/)

  const again = await dispatchOutbox({ config })
  assert.ok(!again.sent.includes(entry.id), 'a held entry waits for a person')
  retryOutbox(entry.id)
  assert.equal(db.getOutboxEntry(entry.id).status, 'pending')
  const forced = await sendOne(entry.id, { config: { ...config, outboxCommand: 'cat > /dev/null' }, force: true })
  assert.equal(forced.ok, true)
})

test('one run leaves work for another job', async () => {
  const worker = db.createWorker({ name: 'handler', adapter: 'process', config: { command: 'echo handled' } })
  const second = db.createJob({ workerId: worker.id, name: 'second-job', schedule: 'manual' })
  const talker = db.createWorker({ name: 'talker', adapter: 'process', config: { command: 'echo "::reply second-job the new file is on disk"' } })
  const first = db.createJob({ workerId: talker.id, name: 'first-job', schedule: 'manual' })

  await startJob(first, { trigger: 'test' })
  const waiting = db.listInbox({ jobId: second.id, status: 'pending' })
  assert.equal(waiting.length, 1)
  assert.equal(waiting[0].source, 'reply')
  assert.equal(waiting[0].payload.fromJob, 'first-job')

  await tick()
  assert.equal(db.getInboxEvent(waiting[0].id).status, 'done')
  assert.equal(db.lastRun(second.id).status, 'ok')
})

test('an inbox event in front of an approval gate waits, it does not run twice', async () => {
  const worker = db.createWorker({ name: 'gated', adapter: 'process', config: { command: 'echo gone out' } })
  const job = db.createJob({ workerId: worker.id, name: 'gated-job', schedule: 'manual', requiresApproval: true })
  const { event } = db.addInboxEvent({ jobId: job.id, source: 'webhook', payload: { message: 'please do it' }, dedupeKey: 'gated-1' })

  await tick()
  const claimed = db.getInboxEvent(event.id)
  assert.equal(claimed.status, 'claimed', 'the event stays in hand while a person thinks')
  assert.equal(db.getRun(claimed.run_id).status, 'awaiting_approval')

  await tick()
  assert.equal(db.listRuns({ jobId: job.id, limit: 10 }).length, 1, 'no second run while the first waits')

  const approval = db.listApprovals({ state: 'pending' }).find((a) => a.job_id === job.id)
  db.decideApproval(approval.id, 'approved', { by: 'test' })
  await tick()
  assert.equal(db.getRun(claimed.run_id).status, 'ok')
  assert.equal(db.getInboxEvent(event.id).status, 'done', 'the approved run settles the event it came from')
})

test('an outbox decision moves the entry and never starts the finished run again', async () => {
  const config = { outboxSend: true, outboxCommand: 'cat > /dev/null', outboxRequiresApproval: true, outboxPerTick: 5, outboxMinGapSec: 0 }
  const job = db.getJob('letter-job')
  const run = db.lastRun(job.id, 'ok')
  const { entry } = db.addOutboxEntry({ jobId: job.id, runId: run.id, channel: 'note', body: 'one more letter', dedupeKey: 'decided-one' })

  await dispatchOutbox({ config })
  const approvalId = db.getOutboxEntry(entry.id).approval_id
  db.decideApproval(approvalId, 'approved', { by: 'test' })

  await assert.rejects(() => runApproved(approvalId), /guards an outbox/)
  const runsBefore = db.listRuns({ jobId: job.id, limit: 50 }).length

  const result = await sendOne(entry.id, { config })
  assert.equal(result.ok, true)
  assert.equal(db.getOutboxEntry(entry.id).status, 'sent')
  assert.equal(db.listRuns({ jobId: job.id, limit: 50 }).length, runsBefore, 'the run behind the entry stays where it was')
  assert.equal(db.getRun(run.id).status, 'ok')
})

test('the counts the board draws add up', () => {
  const inbox = db.inboxCounts()
  const outbox = db.outboxCounts()
  assert.equal(typeof inbox.pending, 'number')
  assert.equal(typeof inbox.claimed, 'number')
  assert.ok(outbox.sent >= 3)
  assert.ok(db.memoryCount() >= 1)
})

test('a webhook can describe work but cannot change what runs', async () => {
  const marker = join(home, 'webhook-ran')
  const worker = db.createWorker({ name: 'guarded', adapter: 'process', config: { command: 'echo the job command' } })
  const job = db.createJob({ workerId: worker.id, name: 'guarded-job', schedule: 'manual' })
  const { event } = db.addInboxEvent({
    jobId: job.id,
    source: 'webhook',
    payload: { message: 'new file', command: `touch ${marker}`, cwd: '/' },
    dedupeKey: 'hostile-1',
  })
  await tick()
  const run = db.getRun(db.getInboxEvent(event.id).run_id)
  assert.equal(run.status, 'ok')
  assert.match(run.stdout, /the job command/, 'the command of the job ran')
  assert.ok(!existsSync(marker), 'the command from the webhook did not')
})
