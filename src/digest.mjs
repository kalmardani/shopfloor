import { spawn } from 'node:child_process'
import * as db from './db.mjs'
import { loadConfig } from './config.mjs'
import { shopHealth, humanAge, startOfToday } from './health.mjs'
import { maybeSendReviews } from './review.mjs'

// The one piece of writing the shop floor hands you every morning. It names
// what stopped quietly, what is waiting for a decision, and what the day cost.
export function buildDigest ({ hours = 24, at = Date.now() } = {}) {
  const since = at - hours * 3600 * 1000
  const health = shopHealth({ at })
  const runs = db.listRuns({ limit: 500 }).filter((r) => r.queued_at >= since)
  const byStatus = runs.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc }, {})
  const failures = runs.filter((r) => ['fail', 'timeout', 'lost', 'quota'].includes(r.status))
  const cost = runs.reduce((sum, r) => sum + (r.cost_usd || 0), 0)
  const lines = []

  lines.push(`# Shopfloor digest, ${new Date(at).toLocaleString()}`)
  lines.push('')

  if (health.attention.length === 0) {
    lines.push('Every job is inside its window.')
  } else {
    lines.push(`## Needs attention (${health.attention.length})`)
    for (const item of health.attention) {
      lines.push(`- **${item.job.name}** ${item.problems.map((p) => p.message).join('; ')}`)
    }
  }
  lines.push('')

  if (health.pendingApprovals.length) {
    lines.push(`## Waiting for a decision (${health.pendingApprovals.length})`)
    for (const a of health.pendingApprovals) {
      lines.push(`- ${a.job_name || a.job_id} asked ${humanAge(at - a.requested_at)} ago: ${a.question || 'may it run?'} (${a.id.slice(0, 8)})`)
    }
    lines.push('')
  }

  const inbox = db.inboxCounts()
  const outbox = db.outboxCounts()
  if (inbox.pending || inbox.claimed || outbox.pending || outbox.held) {
    lines.push('## The two queues')
    if (inbox.pending || inbox.claimed) lines.push(`- inbox ${inbox.pending} waiting, ${inbox.claimed} in hand`)
    if (outbox.pending || outbox.held) {
      const quiet = loadConfig().outboxSend ? '' : ', and sending is off'
      lines.push(`- outbox ${outbox.pending} pending, ${outbox.held} held${quiet}`)
    }
    lines.push('')
  }

  const roles = db.listRoles()
  if (roles.length) {
    lines.push('## Roles')
    for (const role of roles) {
      const drafts = health.pendingApprovals.filter((a) => a.job_id === role.job_id && a.kind === 'outbox').length
      lines.push(`- ${role.job_name}, ${role.spec.title}, ${role.job_enabled ? 'on' : 'off'}, ${drafts} draft(s) waiting, review on ${role.spec.reviewDay}`)
    }
    lines.push('')
  }

  lines.push(`## Last ${hours} hours`)
  lines.push(`- ${runs.length} run(s): ${Object.entries(byStatus).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}`)
  lines.push(`- cost ${cost.toFixed(2)} USD, today ${db.costSince(startOfToday()).toFixed(2)} USD of ${loadConfig().maxUsdPerDay} USD`)
  if (failures.length) {
    lines.push('')
    lines.push('### What went wrong')
    for (const f of failures.slice(0, 10)) {
      lines.push(`- ${f.job_name || f.job_id} ${f.status}: ${(f.summary || f.stderr || '').trim().split('\n')[0]?.slice(0, 200) || 'no message'}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

let lastDigestDay = null

// Fires once a day, at the hour in the config, without a second scheduler.
export async function maybeSendDigest ({ config = loadConfig(), at = Date.now() } = {}) {
  if (!config.digestAt) return false
  const [hour, minute] = String(config.digestAt).split(':').map(Number)
  const now = new Date(at)
  const day = now.toDateString()
  if (lastDigestDay === day) return false
  const slot = new Date(at)
  slot.setHours(hour || 0, minute || 0, 0, 0)
  if (at < slot.getTime()) return false
  lastDigestDay = day
  const text = buildDigest({ at })
  db.addEvent({ level: 'info', kind: 'digest', message: text.split('\n').slice(0, 6).join(' ') })
  await notify(text, config)
  // A role's weekly review rides along with the digest on its review day, so
  // it arrives through the same command and at the same hour.
  try {
    await maybeSendReviews({ config, at })
  } catch (err) {
    db.addEvent({ level: 'error', kind: 'role:review', message: `the weekly review failed: ${err.message}` })
  }
  return true
}

// Notification stays yours. Whatever command is in the config gets the digest
// on standard input, so Telegram, mail, a file or a desktop banner all work
// without this project growing a single dependency.
export function notify (text, config = loadConfig()) {
  return new Promise((resolve) => {
    if (!config.notifyCommand) { resolve(false); return }
    const child = spawn(process.env.SHELL || '/bin/sh', ['-lc', config.notifyCommand], { stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('error', () => resolve(false))
    child.on('close', () => resolve(true))
    child.stdin.on('error', () => {})
    child.stdin.end(text)
  })
}

export function resetDigestMemory () { lastDigestDay = null }
