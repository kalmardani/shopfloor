import { getAdapter } from './adapters/index.mjs'
import { loadConfig } from './config.mjs'
import * as db from './db.mjs'
import { nextRun } from './schedule.mjs'

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

// One run, start to finish: the gates in front of it, the adapter call, and
// the record left behind. Returns the stored run row.
export async function executeRun ({ run, job, worker, config = loadConfig(), signal = null }) {
  const timeoutSec = job?.timeout_sec || config.defaultTimeoutSec
  db.updateRun(run.id, { status: 'running', startedAt: Date.now() })

  let result
  try {
    const adapter = getAdapter(worker.adapter)
    result = await adapter.run({ worker, job, payload: job?.payload || {}, timeoutSec, signal })
  } catch (err) {
    result = { exitCode: null, stdout: '', stderr: String(err?.stack || err?.message || err), costUsd: 0, summary: 'the adapter threw', error: String(err?.message || err) }
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

    if (status === 'quota') {
      // Nothing is wrong with the job, the plan is simply out of room for now.
      db.setNextAt(job.id, Date.now() + config.retryAfterQuotaSec * 1000)
    } else {
      db.setNextAt(job.id, nextRun(job.schedule, Date.now()))
    }
  }

  return stored
}

// Start a job now. Honours the approval gate and the day's budget, which is
// why it is used by the scheduler, the CLI and the web interface alike.
export async function startJob (jobRef, { trigger = 'manual', force = false, config = loadConfig(), signal = null } = {}) {
  const job = typeof jobRef === 'string' ? db.getJob(jobRef) : jobRef
  if (!job) throw new Error(`no such job: ${jobRef}`)
  const worker = db.getWorker(job.worker_id)
  if (!worker) throw new Error(`job ${job.name} has no worker`)
  if (!worker.enabled && !force) throw new Error(`worker ${worker.name} is switched off`)

  if (job.requires_approval && !force) {
    const run = db.createRun({ jobId: job.id, workerId: worker.id, status: 'awaiting_approval', trigger })
    const approval = db.createApproval({ runId: run.id, jobId: job.id, question: job.goal || `Run ${job.name}?` })
    db.addEvent({ level: 'warn', kind: 'approval:requested', jobId: job.id, runId: run.id, message: `waiting for a decision (${approval.id.slice(0, 8)})` })
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
    return { run: db.getRun(run.id), started: false, blocked: which }
  }

  const run = db.createRun({ jobId: job.id, workerId: worker.id, status: 'queued', trigger })
  const finished = await executeRun({ run, job, worker, config, signal })
  return { run: finished, started: true }
}

// An approved run waits in the database until someone says yes, and then it
// goes through without the gate asking again.
export async function runApproved (approvalId, { config = loadConfig() } = {}) {
  const approval = db.getApproval(approvalId)
  if (!approval) throw new Error(`no such approval: ${approvalId}`)
  if (approval.state !== 'approved') throw new Error(`approval is ${approval.state}, not approved`)
  const run = db.getRun(approval.run_id)
  const job = db.getJob(approval.job_id)
  const worker = db.getWorker(run.worker_id)
  return executeRun({ run, job, worker, config })
}
