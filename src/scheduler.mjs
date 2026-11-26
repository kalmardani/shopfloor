import * as db from './db.mjs'
import { loadConfig } from './config.mjs'
import { startJob, runApproved } from './runner.mjs'
import { nextRun } from './schedule.mjs'
import { maybeSendDigest } from './digest.mjs'
import { dispatchOutbox } from './outbox.mjs'

// The heartbeat of the shop floor. One tick lets approved work through, picks
// up what is due, answers what arrived in an inbox, and moves the outgoing
// queue along. Then it goes back to sleep.
export async function tick ({ config = loadConfig(), at = Date.now(), log = () => {} } = {}) {
  const started = []
  const skipped = []

  for (const approval of db.listApprovals({ state: 'approved', limit: 10 })) {
    const run = db.getRun(approval.run_id)
    if (!run || run.status !== 'awaiting_approval') continue
    log(`approved: ${approval.job_name}`)
    await runApproved(approval.id, { config })
    started.push({ job: approval.job_name, trigger: 'approval' })
  }

  const due = db.dueJobs(at)
  for (const job of due) {
    if (db.runningCount() >= config.maxConcurrentRuns) {
      skipped.push({ job: job.name, why: 'the floor is full' })
      continue
    }
    const open = db.lastRun(job.id)
    if (open && open.status === 'running') {
      // The previous run of this job is still going. Give it the next slot.
      db.setNextAt(job.id, nextRun(job.schedule, at))
      skipped.push({ job: job.name, why: 'the previous run is still going' })
      continue
    }
    // The timer writes its firing into the inbox too, so one ledger holds every
    // reason a run ever started. The slot is the dedupe key, which is what
    // stops two schedulers from firing the same slot twice.
    const timer = db.addInboxEvent({ jobId: job.id, source: 'timer', dedupeKey: `timer:${job.next_at}` })
    if (timer.duplicate) {
      db.setNextAt(job.id, nextRun(job.schedule, at))
      skipped.push({ job: job.name, why: 'this slot is already in the inbox' })
      continue
    }
    log(`starting: ${job.name}`)
    const outcome = await startJob(job, { trigger: 'schedule', config })
    db.settleInboxEvent(timer.event.id, 'done', { runId: outcome.run.id, note: `run ended ${outcome.run.status}` })
    started.push({ job: job.name, status: outcome.run.status })
  }

  for (const jobId of db.jobsWithPendingInbox(at)) {
    if (db.runningCount() >= config.maxConcurrentRuns) {
      skipped.push({ job: jobId, why: 'the floor is full' })
      continue
    }
    const job = db.getJob(jobId)
    if (!job) continue
    const open = db.lastRun(job.id)
    if (open && open.status === 'running') {
      skipped.push({ job: job.name, why: 'the previous run is still going' })
      continue
    }
    const event = db.claimInboxEvent(job.id, { at })
    if (!event) {
      skipped.push({ job: job.name, why: 'the inbox already has a worker' })
      continue
    }
    log(`inbox: ${job.name} (${event.source})`)
    const outcome = await startJob(job, { trigger: `inbox:${event.source}`, config, event })
    started.push({ job: job.name, status: outcome.run.status, trigger: 'inbox' })
  }

  const outbox = await dispatchOutbox({ config })
  for (const id of outbox.sent) log(`sent: ${id.slice(0, 8)}`)

  await maybeSendDigest({ config, at })
  return { started, skipped, outbox, at }
}

// Runs the loop until the process is asked to stop.
export async function serveScheduler ({ config = loadConfig(), log = console.log } = {}) {
  const lost = db.markStaleRunsLost()
  if (lost) log(`closed ${lost} run(s) left open by an earlier scheduler`)
  const handedBack = db.releaseClaimedInboxEvents()
  if (handedBack) log(`handed ${handedBack} inbox event(s) back to the queue`)
  for (const job of db.listJobs({ includeDisabled: false })) {
    if (job.next_at === null) db.setNextAt(job.id, nextRun(job.schedule, Date.now()))
  }
  db.addEvent({ level: 'info', kind: 'scheduler:start', message: `tick every ${config.tickSeconds}s` })

  let stop = false
  let lastPrune = 0
  const onSignal = () => { stop = true }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  while (!stop) {
    try {
      const result = await tick({ config, log: (m) => log(`[${stamp()}] ${m}`) })
      if (result.started.length === 0 && result.skipped.length === 0) { /* quiet tick, nothing to say */ }
      if (Date.now() - lastPrune > 6 * 3600 * 1000) {
        lastPrune = Date.now()
        const removed = db.pruneRuns(config.keepRunDays)
        const settled = db.pruneInbox(config.keepRunDays) + db.pruneOutbox(config.keepRunDays)
        if (removed) log(`[${stamp()}] pruned ${removed} old run(s)`)
        if (settled) log(`[${stamp()}] pruned ${settled} settled inbox and outbox row(s)`)
      }
    } catch (err) {
      log(`[${stamp()}] tick failed: ${err.message}`)
      db.addEvent({ level: 'error', kind: 'scheduler:error', message: String(err.message) })
    }
    await sleep(config.tickSeconds * 1000, () => stop)
  }

  db.addEvent({ level: 'info', kind: 'scheduler:stop', message: 'asked to stop' })
  log('scheduler stopped')
}

function sleep (ms, isStopped) {
  return new Promise((resolve) => {
    const step = 250
    let waited = 0
    const timer = setInterval(() => {
      waited += step
      if (waited >= ms || isStopped()) { clearInterval(timer); resolve() }
    }, step)
  })
}

function stamp () {
  return new Date().toLocaleTimeString()
}
