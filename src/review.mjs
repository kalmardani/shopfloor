import * as db from './db.mjs'
import { loadConfig } from './config.mjs'
import { movement, formatChange, METRIC_LABELS, round } from './sources/google.mjs'
import { notify } from './digest.mjs'

// The weekly review of one role, the call Sam Oh has with his agents once a
// week, written down. What the worker did, what it cost, how the number it is
// paid to move actually moved, and what a person said yes and no to. Every
// figure here is counted from the database, none is taken from the agent.

const DAY = 86400 * 1000
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

export function reviewData (job, { at = Date.now(), days = 7 } = {}) {
  const role = db.getRole(job.id)
  if (!role) throw new Error(`${job.name} has no role`)
  const spec = role.spec
  const since = at - days * DAY

  const runs = db.listRuns({ jobId: job.id, limit: 1000 }).filter((r) => r.queued_at >= since && r.queued_at <= at)
  const byStatus = {}
  for (const r of runs) byStatus[r.status] = (byStatus[r.status] || 0) + 1
  const cost = runs.reduce((sum, r) => sum + Number(r.cost_usd || 0), 0)
  const budget = spec.budgetUsdDay * days

  const entries = db.outboxWithDecisions(job.id, { since, until: at })
  const decisions = db.decisionsFor(job.id, { since, until: at })
  const approved = decisions.filter((d) => d.state === 'approved')
  const rejected = decisions.filter((d) => d.state === 'rejected')
  const waiting = db.listApprovals({ state: 'pending', limit: 500 }).filter((a) => a.job_id === job.id && a.kind === 'outbox')
  const events = db.eventsFor(job.id, { kinds: ['role:refused', 'role:style', 'role:data', 'memory:write'], since, until: at })

  // The metric movement comes from the newest snapshot that had data, and the
  // oldest one of the week shows whether the reading changed while it worked.
  const snapshots = db.listRoleSnapshots(job.id, { since, until: at, onlyOk: false }).filter((s) => s.data?.gsc || s.data?.ga4)
  const latest = snapshots.at(-1)?.data || null
  const earliest = snapshots[0]?.data || null

  return {
    job, spec, role, at, since, days,
    runs, byStatus, cost, budget,
    entries, decisions, approved, rejected, waiting,
    refused: events.filter((e) => e.kind === 'role:refused'),
    styleHeld: events.filter((e) => e.kind === 'role:style'),
    dataProblems: events.filter((e) => e.kind === 'role:data'),
    memoryWrites: events.filter((e) => e.kind === 'memory:write').length,
    latest, earliest,
    move: latest ? movement(latest) : {},
  }
}

export function buildReview (job, options = {}) {
  const r = reviewData(job, options)
  const { spec } = r
  const lines = []
  const day = (ms) => new Date(ms).toLocaleDateString()
  const usd = (v) => `${round(v, 2).toFixed(2)} USD`

  lines.push(`# Weekly review, ${job.name}`)
  lines.push(`${spec.title}, ${day(r.since)} to ${day(r.at)}. Goal metric ${METRIC_LABELS[spec.goalMetric] || spec.goalMetric}.${job.enabled ? '' : ' The job is switched off.'}`)
  lines.push('')

  lines.push('## What it did')
  if (!r.runs.length) {
    lines.push('- No shift ran this week.')
  } else {
    lines.push(`- ${r.runs.length} shift(s): ${Object.entries(r.byStatus).map(([k, v]) => `${v} ${k}`).join(', ')}`)
    lines.push(`- ${r.entries.length} draft(s) made, ${r.memoryWrites} memory update(s)`)
    if (r.styleHeld.length) lines.push(`- ${r.styleHeld.length} draft(s) held back by the writing check`)
    if (r.refused.length) {
      lines.push(`- ${r.refused.length} attempt(s) outside the role were refused`)
      for (const e of r.refused.slice(0, 5)) lines.push(`    ${e.message}`)
    }
    for (const run of r.runs.filter((x) => x.status !== 'ok').slice(0, 5)) {
      lines.push(`- ${day(run.queued_at)} ${run.status}: ${(run.summary || '').split('\n')[0].slice(0, 160)}`)
    }
  }
  lines.push('')

  lines.push('## What it cost')
  const per = r.approved.length ? `, ${usd(r.cost / r.approved.length)} per approved proposal` : ''
  const share = r.budget ? round((r.cost / r.budget) * 100, 1) : 0
  lines.push(`- ${usd(r.cost)} of ${usd(r.budget)} allowed (${share}% of ${spec.budgetUsdDay} USD a day for ${r.days} days)${per}`)
  lines.push('')

  lines.push('## How the numbers moved')
  if (!r.latest) {
    lines.push('- No data reached the worker this week, so there is nothing to compare.')
  } else {
    const w = r.latest.windows
    lines.push(`Week ${w.current.start} to ${w.current.end} against ${w.previous.start} to ${w.previous.end}.`)
    const goal = r.move[spec.goalMetric]
    if (goal) lines.push(`- **${METRIC_LABELS[spec.goalMetric]}** ${formatChange(goal)}`)
    for (const [key, m] of Object.entries(r.move)) if (key !== spec.goalMetric) lines.push(`- ${METRIC_LABELS[key]} ${formatChange(m)}`)
    if (r.earliest && r.earliest !== r.latest && r.earliest.windows.current.end !== w.current.end) {
      const before = movement(r.earliest)[spec.goalMetric]
      if (before && goal) lines.push(`- At the start of the week the same reading was ${before.current} for ${r.earliest.windows.current.start} to ${r.earliest.windows.current.end}.`)
    }
  }
  if (r.dataProblems.length) lines.push(`- ${r.dataProblems.length} time(s) a source could not be read, last: ${r.dataProblems.at(-1).message.slice(0, 160)}`)
  lines.push('')

  lines.push('## Decisions')
  lines.push(`- ${r.approved.length} approved, ${r.rejected.length} rejected, ${r.waiting.length} still waiting`)
  for (const d of r.approved) lines.push(`- yes: ${(d.subject || d.question || '').slice(0, 120)}`)
  for (const d of r.rejected) lines.push(`- no: ${(d.subject || d.question || '').slice(0, 120)}${d.note ? `. Why: ${d.note.slice(0, 160)}` : ''}`)
  for (const a of r.waiting.slice(0, 10)) lines.push(`- waiting (${a.id.slice(0, 8)}): ${(a.question || '').slice(0, 120)}`)
  if (r.waiting.length) lines.push(`Decide with shopfloor approve <id> or shopfloor reject <id> --note "why".`)
  lines.push('')
  return lines.join('\n')
}

// Called right after the morning digest, on the review day of each role, so
// the week arrives through the same notifyCommand and at the same hour. The
// guard is an event per job, which survives a restart of the scheduler.
export async function maybeSendReviews ({ config = loadConfig(), at = Date.now() } = {}) {
  const sent = []
  const today = WEEKDAYS[new Date(at).getDay()]
  for (const role of db.listRoles()) {
    if ((role.spec.reviewDay || 'mon') !== today) continue
    const job = db.getJob(role.job_id)
    if (!job) continue
    const recent = db.eventsFor(job.id, { kinds: ['role:review'], since: at - 6 * DAY, until: at })
    if (recent.length) continue
    const data = reviewData(job, { at })
    if (!job.enabled && !data.runs.length && !data.waiting.length) continue
    const text = buildReview(job, { at })
    db.addEvent({ level: 'info', kind: 'role:review', jobId: job.id, message: text.split('\n').slice(0, 2).join(' ').slice(0, 300) })
    await notify(text, config)
    sent.push(job.name)
  }
  return sent
}
