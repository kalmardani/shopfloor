import { getAdapter } from './adapters/index.mjs'
import { loadConfig } from './config.mjs'
import * as db from './db.mjs'
import { nextRun } from './schedule.mjs'
import { memoryBlock, applyMemoryWrites } from './memory.mjs'
import { parseDirectives } from './directives.mjs'
import { queueFromRun } from './outbox.mjs'
import { prepareRoleRun, screenRoleOutput } from './role.mjs'

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() }

export function budgetState (worker, config = loadConfig()) {
  const today = startOfToday()
  const spentGlobal = db.costSince(today)
  const spentWorker = worker ? db.costSince(today, { workerId: worker.id }) : 0
  const globalCap = config.maxUsdPerDay ?? null
  const workerCap = worker?.max_usd_day ?? null
  return {
    spentGlobal,
    spentWorker,
    globalCap,
    workerCap,
    globalExceeded: globalCap !== null && spentGlobal >= globalCap,
    workerExceeded: workerCap !== null && spentWorker >= workerCap,
  }
}

// One run, start to finish. The gates in front of it, what the job knows, the
// adapter call, and the record left behind. Returns the stored run row.
export async function executeRun ({ run, job, worker, config = loadConfig(), signal = null, event = null }) {
  const timeoutSec = job?.timeout_sec || config.defaultTimeoutSec
  const inboxEvent = event ?? db.inboxEventForRun(run.id)
  db.updateRun(run.id, { status: 'running', startedAt: Date.now() })

  // What the job knows and what woke it up travel together, in the payload, so
  // an adapter needs no knowledge of either store.
  const payload = {
    ...(job?.payload || {}),
    ...(inboxEvent?.payload || {}),
    memory: memoryBlock(job, { config }),
    event: inboxEvent ? { id: inboxEvent.id, source: inboxEvent.source, payload: inboxEvent.payload } : null,
  }

  // A role run gathers its numbers first and carries its boundaries into the
  // payload, where they override whatever the worker config says.
  const role = job ? db.getRole(job.id) : null
  let result = null
  if (role && worker.adapter !== 'claude_local') {
    // Only claude_local knows how to narrow a run, so a role on any other
    // adapter would carry its boundaries in name only.
    const why = `a role runs on claude_local only, and ${worker.name} is ${worker.adapter}`
    result = { exitCode: 1, stdout: '', stderr: why, costUsd: 0, summary: why }
  } else if (role) {
    try {
      const budget = budgetState(worker, config)
      const left = [budget.workerCap === null ? null : budget.workerCap - budget.spentWorker,
        budget.globalCap === null ? null : budget.globalCap - budget.spentGlobal].filter((v) => v !== null)
      const prep = await prepareRoleRun({ job, run, role, remainingUsd: left.length ? Math.min(...left) : null })
      if (prep.stop) result = prep.result
      else {
        // Nothing that arrived from outside may set how a role runs. An event
        // reaches the agent as text under payload.event and nowhere else.
        for (const key of Object.keys(payload)) if (key !== 'memory' && key !== 'event') delete payload[key]
        Object.assign(payload, prep.payload)
      }
    } catch (err) {
      result = { exitCode: null, stdout: '', stderr: String(err?.stack || err?.message || err), costUsd: 0, summary: 'the role could not be prepared', error: String(err?.message || err) }
    }
  }

  if (!result) {
    try {
      const adapter = getAdapter(worker.adapter)
      result = await adapter.run({ worker, job, payload, timeoutSec, signal })
    } catch (err) {
      result = { exitCode: null, stdout: '', stderr: String(err?.stack || err?.message || err), costUsd: 0, summary: 'the adapter threw', error: String(err?.message || err) }
    }
  }

  const status = result.timedOut
    ? 'timeout'
    : result.aborted
      ? 'cancelled'
      : result.quotaProblem
        ? 'quota'
        : result.exitCode === 0
          ? 'ok'
          : 'fail'

  const keep = config.keepRunOutputChars
  const stored = db.updateRun(run.id, {
    status,
    endedAt: Date.now(),
    exitCode: result.exitCode,
    costUsd: Number(result.costUsd || 0),
    summary: result.summary || null,
    stdout: (result.stdout || '').slice(-keep),
    stderr: (result.stderr || '').slice(-keep),
  })

  if (job) {
    const level = status === 'ok' ? 'info' : status === 'quota' ? 'warn' : 'error'
    db.addEvent({
      level,
      kind: `run:${status}`,
      jobId: job.id,
      runId: run.id,
      message: status === 'ok'
        ? (result.summary || 'finished').slice(0, 300)
        : `${status}${result.exitCode === null ? '' : ' (exit ' + result.exitCode + ')'}: ${(result.stderr || result.summary || '').trim().slice(0, 300)}`,
    })

    if (status === 'ok') await applyRunDirectives({ run: stored, job, result, config, role })

    if (status === 'quota') {
      // Nothing is wrong with the job, the plan is simply out of room for now.
      db.setNextAt(job.id, Date.now() + config.retryAfterQuotaSec * 1000)
    } else if (!inboxEvent || inboxEvent.source === 'timer') {
      // An event driven run keeps its hands off the timer, because the slot
      // belongs to the schedule and not to whatever just arrived.
      db.setNextAt(job.id, nextRun(job.schedule, Date.now()))
    }
  }

  if (inboxEvent && inboxEvent.status === 'claimed') {
    if (status === 'quota') {
      // The arrival is not the problem, so it waits rather than counting as done.
      db.settleInboxEvent(inboxEvent.id, 'pending', {
        runId: run.id,
        note: 'the plan was out of room, back in the queue',
        waitUntil: Date.now() + config.retryAfterQuotaSec * 1000,
      })
    } else {
      db.settleInboxEvent(inboxEvent.id, 'done', { runId: run.id, note: `run ended ${status}` })
    }
  }

  return stored
}

// What the run asked for in its own output. Memory writes, replies into an
// inbox, entries in the outbox. Only a run that ended well is believed, since
// half of a crashed answer is not an instruction.
async function applyRunDirectives ({ run, job, result, config, role = null }) {
  let directives = parseDirectives(result.stdout || '')
  // A role is screened before anything is stored. Its drafts go in front of
  // the gate, and what it may not do is refused and written down.
  if (role) directives = (await screenRoleOutput({ job, run, role, directives, config })).directives
  applyMemoryWrites(job, directives, { runId: run.id, source: 'run', config })
  queueFromRun({ job, run, directives, config })

  for (const reply of directives.replies) {
    const target = reply.job ? db.getJob(reply.job) : job
    if (!target) {
      db.addEvent({ level: 'warn', kind: 'inbox:unknown', jobId: job.id, runId: run.id, message: `no job called ${reply.job}` })
      continue
    }
    const { event, duplicate } = db.addInboxEvent({
      jobId: target.id,
      source: 'reply',
      payload: { message: reply.message, fromJob: job.name },
      parentRunId: run.id,
      dedupeKey: `reply:${run.id}:${target.id}:${reply.message.slice(0, 60)}`,
    })
    if (!duplicate) {
      db.addEvent({ level: 'info', kind: 'inbox:reply', jobId: target.id, runId: run.id, message: `${job.name} left work for ${target.name} (${event.id.slice(0, 8)})` })
    }
  }

  for (const problem of directives.errors) {
    db.addEvent({ level: 'warn', kind: 'directive:unreadable', jobId: job.id, runId: run.id, message: problem })
  }
}

// Start a job now. Honours the approval gate and the day's budget, which is
// why it is used by the scheduler, the CLI and the web interface alike.
export async function startJob (jobRef, { trigger = 'manual', force = false, config = loadConfig(), signal = null, event = null } = {}) {
  const job = typeof jobRef === 'string' ? db.getJob(jobRef) : jobRef
  if (!job) throw new Error(`no such job: ${jobRef}`)
  const worker = db.getWorker(job.worker_id)
  if (!worker) throw new Error(`job ${job.name} has no worker`)
  if (!worker.enabled && !force) throw new Error(`worker ${worker.name} is switched off`)

  if (job.requires_approval && !force) {
    const run = db.createRun({ jobId: job.id, workerId: worker.id, status: 'awaiting_approval', trigger })
    const approval = db.createApproval({ runId: run.id, jobId: job.id, question: job.goal || `Run ${job.name}?` })
    db.addEvent({ level: 'warn', kind: 'approval:requested', jobId: job.id, runId: run.id, message: `waiting for a decision (${approval.id.slice(0, 8)})` })
    // The event stays claimed while a person thinks about it, which is how the
    // inbox keeps one worker and does not start the same work twice.
    if (event) db.attachInboxRun(event.id, run.id)
    db.setNextAt(job.id, nextRun(job.schedule, Date.now()))
    return { run: db.getRun(run.id), approval, started: false }
  }

  const budget = budgetState(worker, config)
  const costs = worker.adapter === 'claude_local'
  if (costs && (budget.globalExceeded || budget.workerExceeded) && !force) {
    const run = db.createRun({ jobId: job.id, workerId: worker.id, status: 'blocked', trigger })
    const which = budget.workerExceeded ? `${worker.name} is at its ${budget.workerCap} USD day cap` : `the shop floor is at its ${budget.globalCap} USD day cap`
    db.updateRun(run.id, { endedAt: Date.now(), summary: which })
    db.addEvent({ level: 'warn', kind: 'run:blocked', jobId: job.id, runId: run.id, message: which })
    db.setNextAt(job.id, nextRun(job.schedule, Date.now()))
    if (event) {
      db.settleInboxEvent(event.id, 'pending', { runId: run.id, note: which, waitUntil: Date.now() + config.retryAfterQuotaSec * 1000 })
    }
    return { run: db.getRun(run.id), started: false, blocked: which }
  }

  const run = db.createRun({ jobId: job.id, workerId: worker.id, status: 'queued', trigger })
  const finished = await executeRun({ run, job, worker, config, signal, event })
  return { run: finished, started: true }
}

// An approved run waits in the database until someone says yes, and then it
// goes through without the gate asking again.
export async function runApproved (approvalId, { config = loadConfig() } = {}) {
  const approval = db.getApproval(approvalId)
  if (!approval) throw new Error(`no such approval: ${approvalId}`)
  if (approval.state !== 'approved') throw new Error(`approval is ${approval.state}, not approved`)
  if (approval.kind !== 'run') throw new Error(`approval ${approval.id.slice(0, 8)} guards an ${approval.kind}, not a run`)
  const run = db.getRun(approval.run_id)
  if (run && run.status !== 'awaiting_approval') throw new Error(`that run already ended ${run.status}`)
  const job = db.getJob(approval.job_id)
  const worker = db.getWorker(run.worker_id)
  return executeRun({ run, job, worker, config })
}
