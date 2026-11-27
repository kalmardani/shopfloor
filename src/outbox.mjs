import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as db from './db.mjs'
import { loadConfig, HOME } from './config.mjs'
import { runCommand } from './adapters/spawn.mjs'

// The outgoing queue. A run leaves finished work here and the work waits, so a
// stdout line can never become a letter on its own.
//
// Two rules hold this together. The shop floor starts quiet, which means
// `outboxSend` is off until someone turns it on. And sending is paced, so a
// job that writes twenty entries in one run does not post twenty messages in
// one second.
//
// The gate in front of a send is the approval gate that is already here. An
// outbox entry asks for the same kind of decision a job does, lands in the
// same queue, and is approved from the same places.

export function queueFromRun ({ job, run, directives, config = loadConfig() }) {
  const queued = []
  for (const entry of directives.outbox || []) {
    if (!entry.body) continue
    const { entry: stored, duplicate } = db.addOutboxEntry({
      jobId: job?.id || null,
      runId: run?.id || null,
      channel: entry.channel,
      recipient: entry.recipient,
      subject: entry.subject,
      body: entry.body.slice(0, config.keepRunOutputChars || 20000),
      dedupeKey: entry.dedupeKey,
    })
    if (duplicate) continue
    db.addEvent({
      level: 'info',
      kind: 'outbox:queued',
      jobId: job?.id || null,
      runId: run?.id || null,
      message: `${stored.channel} to ${stored.recipient || 'nobody in particular'} (${stored.id.slice(0, 8)})`,
    })
    queued.push(stored)
  }
  return queued
}

// Called from the tick and from the command line. Nothing moves unless the
// configuration says the shop may speak.
export async function dispatchOutbox ({ config = loadConfig(), limit = null } = {}) {
  const outcome = { sent: [], held: [], waiting: [], silent: false }
  if (!config.outboxSend) {
    outcome.silent = true
    outcome.reason = 'outboxSend is off, the shop floor stays quiet'
    return outcome
  }
  if (!config.outboxCommand) {
    outcome.silent = true
    outcome.reason = 'no outboxCommand in the config, nothing can carry an entry'
    return outcome
  }

  const perTick = Number(limit ?? config.outboxPerTick ?? 1)
  const gapMs = Number(config.outboxMinGapSec ?? 60) * 1000
  let lastSent = db.lastOutboxSentAt()

  for (const entry of db.listOutbox({ limit: 200 })) {
    if (entry.status === 'sent') continue
    if (outcome.sent.length >= perTick) { outcome.waiting.push(entry.id); continue }

    if (entry.status === 'held') {
      // A held entry waits for a person, whether it was stopped by the gate or
      // by a delivery that failed. Only an approved decision lets it move, and
      // a failed delivery drops that decision, so nothing retries by itself.
      const approval = entry.approval_id ? db.getApproval(entry.approval_id) : null
      if (approval?.state !== 'approved') { outcome.held.push(entry.id); continue }
    } else {
      const decision = gateFor(entry, { config })
      if (decision.wait) { outcome.held.push(entry.id); continue }
    }

    // The gap is measured from now and not from the start of the pass, because
    // a delivery inside this loop has already moved the clock.
    if (gapMs > 0 && lastSent && Date.now() - lastSent < gapMs) { outcome.waiting.push(entry.id); continue }
    const sent = await deliver(entry, { config })
    lastSent = Date.now()
    if (sent.ok) outcome.sent.push(entry.id)
    else outcome.held.push(entry.id)
  }

  return outcome
}

// Back in the queue after a failed delivery was dealt with.
export function retryOutbox (id) {
  const entry = db.getOutboxEntry(id)
  if (!entry) throw new Error(`no such outbox entry: ${id}`)
  if (entry.status === 'sent') throw new Error('it already went out')
  return db.updateOutboxEntry(entry.id, { status: 'pending', note: null, approvalId: null })
}

// Whether this entry may go out now, and what to do about it if it may not.
function gateFor (entry, { config }) {
  // A draft is a proposal by definition, so it asks a person whatever the
  // config says about the rest of the outbox.
  if (config.outboxRequiresApproval === false && entry.channel !== 'draft') return { wait: false }
  const approval = entry.approval_id ? db.getApproval(entry.approval_id) : null
  if (approval?.state === 'approved') return { wait: false }
  if (approval?.state === 'pending') return { wait: true }
  if (approval?.state === 'rejected') {
    if (entry.status !== 'held') {
      db.updateOutboxEntry(entry.id, { status: 'held', note: approval.note || 'a human said no' })
    }
    return { wait: true }
  }

  if (!entry.run_id) {
    // An approval hangs off a run, and this entry has none, so the only way
    // out is by hand with shopfloor outbox send.
    if (entry.status !== 'held') {
      db.updateOutboxEntry(entry.id, { status: 'held', note: 'no run to hang a decision on, send it by hand' })
    }
    return { wait: true }
  }

  const fresh = db.createApproval({
    runId: entry.run_id,
    jobId: entry.job_id,
    question: question(entry),
    kind: 'outbox',
    outboxId: entry.id,
  })
  db.updateOutboxEntry(entry.id, { status: 'held', approvalId: fresh.id })
  db.addEvent({
    level: 'warn',
    kind: 'outbox:held',
    jobId: entry.job_id,
    runId: entry.run_id,
    message: `waiting for a decision before it goes out (${fresh.id.slice(0, 8)})`,
  })
  return { wait: true }
}

function question (entry) {
  const head = (entry.subject || entry.body || '').trim().split('\n')[0].slice(0, 160)
  return `Send on ${entry.channel} to ${entry.recipient || 'nobody in particular'}? ${head}`
}

// Delivery stays yours, the same way notification does. Whatever command is in
// the config receives the entry as JSON on standard input.
export async function deliver (entryRef, { config = loadConfig() } = {}) {
  const entry = typeof entryRef === 'string' ? db.getOutboxEntry(entryRef) : entryRef
  if (!entry) throw new Error(`no such outbox entry: ${entryRef}`)
  if (entry.channel === 'draft') return saveDraft(entry)
  if (!config.outboxCommand) {
    db.updateOutboxEntry(entry.id, { status: 'held', note: 'no outboxCommand in the config, nothing can carry it', approvalId: null })
    return { ok: false, reason: 'no outboxCommand in the config' }
  }

  const result = await runCommand({
    command: config.outboxCommand,
    env: {
      SHOPFLOOR_OUTBOX_ID: entry.id,
      SHOPFLOOR_CHANNEL: entry.channel,
      SHOPFLOOR_RECIPIENT: entry.recipient || '',
      SHOPFLOOR_SUBJECT: entry.subject || '',
    },
    input: JSON.stringify({
      id: entry.id,
      job: entry.job_name || null,
      channel: entry.channel,
      recipient: entry.recipient,
      subject: entry.subject,
      body: entry.body,
    }),
    timeoutSec: Number(config.outboxTimeoutSec ?? 120),
  })

  if (result.exitCode === 0) {
    db.updateOutboxEntry(entry.id, { status: 'sent', sentAt: Date.now(), note: null })
    db.addEvent({
      level: 'info',
      kind: 'outbox:sent',
      jobId: entry.job_id,
      runId: entry.run_id,
      message: `${entry.channel} to ${entry.recipient || 'nobody in particular'} (${entry.id.slice(0, 8)})`,
    })
    return { ok: true }
  }

  const why = (result.stderr || result.stdout || `exit ${result.exitCode}`).trim().slice(0, 300)
  db.updateOutboxEntry(entry.id, { status: 'held', note: why, approvalId: null })
  db.addEvent({
    level: 'error',
    kind: 'outbox:failed',
    jobId: entry.job_id,
    runId: entry.run_id,
    message: why,
  })
  return { ok: false, reason: why }
}

// One entry, by hand, from the command line or the board. Force is the answer
// to a quiet shop floor: it ignores the config and the gate for this entry.
export async function sendOne (id, { config = loadConfig(), force = false } = {}) {
  const entry = db.getOutboxEntry(id)
  if (!entry) throw new Error(`no such outbox entry: ${id}`)
  if (entry.status === 'sent') return { ok: false, reason: 'it already went out' }
  if (!force) {
    // A draft is saved on this machine and goes nowhere else, so a quiet shop
    // floor does not hold it back once a person said yes.
    if (!config.outboxSend && entry.channel !== 'draft') return { ok: false, reason: 'the shop floor is quiet, outboxSend is off' }
    const decision = gateFor(entry, { config })
    if (decision.wait) return { ok: false, reason: 'it is waiting for a decision' }
  }
  return deliver(entry, { config })
}

// The carrier for the draft channel, built in because it never leaves the
// machine. An approved draft becomes a file in the role's drafts folder, which
// the role check keeps outside the site, so a deploy cannot pick it up.
function saveDraft (entry) {
  const role = entry.job_id ? db.getRole(entry.job_id) : null
  const dir = role?.spec?.draftsDir || join(HOME, 'drafts', entry.job_name || 'shop')
  const approval = entry.approval_id ? db.getApproval(entry.approval_id) : null
  const made = new Date(entry.created_at)
  const day = `${made.getFullYear()}-${String(made.getMonth() + 1).padStart(2, '0')}-${String(made.getDate()).padStart(2, '0')}`
  const name = `${day}-${fileSlug(entry.subject || entry.body.split('\n')[0])}-${entry.id.slice(0, 8)}.md`
  const path = join(dir, name)
  const head = [
    '---',
    `job: ${entry.job_name || ''}`,
    `subject: ${JSON.stringify(entry.subject || '')}`,
    `outbox: ${entry.id}`,
    `run: ${entry.run_id || ''}`,
    `made: ${made.toISOString()}`,
    `approved: ${approval?.decided_at ? new Date(approval.decided_at).toISOString() : ''}`,
    approval?.note ? `note: ${JSON.stringify(approval.note)}` : null,
    '---',
    '',
  ].filter((l) => l !== null).join('\n')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, head + entry.body + '\n')
  } catch (err) {
    db.updateOutboxEntry(entry.id, { status: 'held', note: `the draft could not be saved, ${err.message}`, approvalId: null })
    db.addEvent({ level: 'error', kind: 'outbox:failed', jobId: entry.job_id, runId: entry.run_id, message: err.message })
    return { ok: false, reason: err.message }
  }
  db.updateOutboxEntry(entry.id, { status: 'sent', sentAt: Date.now(), note: path })
  db.addEvent({ level: 'info', kind: 'outbox:sent', jobId: entry.job_id, runId: entry.run_id, message: `draft saved to ${path}` })
  return { ok: true, path }
}

function fileSlug (text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'draft'
}
