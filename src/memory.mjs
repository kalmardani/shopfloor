import * as db from './db.mjs'
import { loadConfig } from './config.mjs'

// Memory belongs to the job, not to the run. An agent that crashes, a model
// that is swapped for another, a machine that reboots: none of it touches what
// the job knows, because the knowledge was never inside the process.
//
// The rule that keeps this small. Store only what a run cannot look up again,
// and store a pointer to everything else. A pointer costs one line and never
// goes stale, while a copy of a file is wrong the moment the file changes.

export function memoryBlock (job, { config = loadConfig() } = {}) {
  if (!job) return ''
  const rows = db.listMemory(job.id)
  if (!rows.length) return ''
  const lines = [`# What ${job.name} knows`]
  lines.push('Earlier runs of this job left these notes. A pointer says where to look, not what was there.')
  for (const row of rows) {
    const age = humanAge(Date.now() - row.updated_at)
    lines.push(row.kind === 'pointer'
      ? `- ${row.key} -> ${row.value}   (pointer, ${age} ago, ${provenance(row)})`
      : `- ${row.key} = ${row.value}   (${age} ago, ${provenance(row)})`)
  }
  lines.push('')
  lines.push('To change this, put a line like "::memory key = value" or "::pointer key = where" in your answer.')
  const text = lines.join('\n')
  const cap = config.memoryBlockChars || 4000
  return text.length > cap ? text.slice(0, cap) + '\n(memory block cut off here)' : text
}

function provenance (row) {
  const by = row.source || 'unknown'
  return row.run_id ? `${by} ${String(row.run_id).slice(0, 8)}` : by
}

// Writes from one run. The value is capped, because a run that pastes a whole
// file into memory is the poisoning this store is meant to survive.
export function applyMemoryWrites (job, directives, { runId = null, source = 'run', config = loadConfig() } = {}) {
  if (!job) return { written: 0, forgotten: 0, trimmed: 0 }
  const cap = config.memoryValueChars || 2000
  let written = 0
  let trimmed = 0
  for (const entry of directives.memory || []) {
    const tooLong = entry.value.length > cap
    if (tooLong) trimmed++
    db.setMemory({
      jobId: job.id,
      key: entry.key,
      value: tooLong ? entry.value.slice(0, cap) : entry.value,
      kind: entry.kind,
      source,
      runId,
    })
    written++
  }
  let forgotten = 0
  for (const key of directives.forget || []) forgotten += db.deleteMemory(job.id, key)
  if (written || forgotten) {
    db.addEvent({
      level: 'info',
      kind: 'memory:write',
      jobId: job.id,
      runId,
      message: `${written} written, ${forgotten} forgotten${trimmed ? `, ${trimmed} cut to ${cap} characters` : ''}`,
    })
  }
  return { written, forgotten, trimmed }
}

// What a prompt adapter puts in front of the prompt. Memory first, because it
// is standing knowledge, then whatever arrived in the inbox, because that is
// the reason this run exists at all.
export function promptWithContext (payload, prompt) {
  const parts = []
  // A role briefing comes first of all, because it says who is doing the work.
  if (payload?.briefing) parts.push(payload.briefing)
  if (payload?.memory) parts.push(payload.memory)
  const event = payload?.event
  if (event && event.source !== 'timer') {
    const arrived = typeof event.payload?.message === 'string' ? event.payload.message : JSON.stringify(event.payload ?? {})
    parts.push(`# What arrived\nSource ${event.source}.\n${arrived}`)
  }
  parts.push(prompt)
  return parts.filter(Boolean).join('\n\n')
}

function humanAge (ms) {
  const s = Math.round(Math.abs(ms) / 1000)
  if (s < 90) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 90) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}
