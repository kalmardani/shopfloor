// Schedule strings, in plain words or in cron.
//
//   every 30s | every 15m | every 2h | every 1d
//   daily 07:30
//   weekdays 08:00
//   mon 09:00 | sat 18:00
//   monthly 1 09:00
//   manual                      (never fires on its own)
//   */15 * * * *                (five field cron, minute hour dom month dow)
//
// Times are read in the machine's local zone, because the person reading the
// morning digest lives in that zone.

const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
const UNIT_SEC = { s: 1, m: 60, h: 3600, d: 86400 }

export class ScheduleError extends Error {}

export function parseSchedule (input) {
  const text = String(input ?? '').trim().toLowerCase()
  if (!text) throw new ScheduleError('schedule is empty')
  if (text === 'manual' || text === 'none') return { kind: 'manual', text }

  const every = text.match(/^every\s+(\d+)\s*(s|m|h|d|sec|secs|seconds?|min|mins|minutes?|hours?|days?)$/)
  if (every) {
    const n = Number(every[1])
    if (n <= 0) throw new ScheduleError(`interval must be positive: ${input}`)
    const unit = every[2][0]
    const seconds = n * UNIT_SEC[unit]
    if (seconds < 10) throw new ScheduleError('the shortest interval is 10 seconds')
    return { kind: 'interval', seconds, text }
  }

  const daily = text.match(/^daily\s+(\d{1,2}):(\d{2})$/)
  if (daily) return { kind: 'daily', hour: hh(daily[1]), minute: mm(daily[2]), days: [0, 1, 2, 3, 4, 5, 6], text }

  const weekdays = text.match(/^weekdays?\s+(\d{1,2}):(\d{2})$/)
  if (weekdays) return { kind: 'daily', hour: hh(weekdays[1]), minute: mm(weekdays[2]), days: [1, 2, 3, 4, 5], text }

  const dow = text.match(/^(sun|mon|tue|wed|thu|fri|sat)\s+(\d{1,2}):(\d{2})$/)
  if (dow) return { kind: 'daily', hour: hh(dow[2]), minute: mm(dow[3]), days: [DOW[dow[1]]], text }

  const monthly = text.match(/^monthly\s+(\d{1,2})\s+(\d{1,2}):(\d{2})$/)
  if (monthly) {
    const day = Number(monthly[1])
    if (day < 1 || day > 28) throw new ScheduleError('monthly day must be between 1 and 28, so every month has it')
    return { kind: 'monthly', day, hour: hh(monthly[2]), minute: mm(monthly[3]), text }
  }

  const fields = text.split(/\s+/)
  if (fields.length === 5) return { kind: 'cron', fields: fields.map((f, i) => parseCronField(f, i)), text }

  throw new ScheduleError(`cannot read schedule: ${input}`)
}

function hh (v) {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0 || n > 23) throw new ScheduleError(`hour out of range: ${v}`)
  return n
}

function mm (v) {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0 || n > 59) throw new ScheduleError(`minute out of range: ${v}`)
  return n
}

const CRON_BOUNDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]

function parseCronField (field, index) {
  if (field === '*') return null // null means every value
  const [min, max] = CRON_BOUNDS[index]
  const out = new Set()
  for (const part of field.split(',')) {
    const step = part.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/)
    if (step) {
      const every = Number(step[2])
      if (!every) throw new ScheduleError(`cron step must be positive: ${field}`)
      const [lo, hi] = step[1] === '*' ? [min, max] : rangeOf(step[1], field)
      for (let v = lo; v <= Math.min(hi, max); v += every) out.add(v)
      continue
    }
    const [lo, hi] = rangeOf(part, field)
    if (lo < min || hi > max) throw new ScheduleError(`cron value out of range: ${field}`)
    for (let v = lo; v <= hi; v++) out.add(v)
  }
  if (out.size === 0) throw new ScheduleError(`cron field matches nothing: ${field}`)
  return out
}

function rangeOf (part, field) {
  const m = part.match(/^(\d+)(?:-(\d+))?$/)
  if (!m) throw new ScheduleError(`cannot read cron field: ${field}`)
  const lo = Number(m[1])
  const hi = m[2] === undefined ? lo : Number(m[2])
  if (hi < lo) throw new ScheduleError(`cron range is backwards: ${field}`)
  return [lo, hi]
}

function cronMatch (schedule, date) {
  const values = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()]
  for (let i = 0; i < 5; i++) {
    const set = schedule.fields[i]
    if (set === null) continue
    let v = values[i]
    if (i === 4 && v === 0 && set.has(7)) v = 7
    if (!set.has(v)) return false
  }
  return true
}

// Next firing time strictly after `after`, in milliseconds since the epoch.
// Returns null for manual schedules and for cron patterns that never match.
export function nextRun (schedule, after = Date.now(), lastRunAt = null) {
  const s = typeof schedule === 'string' ? parseSchedule(schedule) : schedule
  if (s.kind === 'manual') return null

  if (s.kind === 'interval') {
    const base = lastRunAt ?? after
    let next = base + s.seconds * 1000
    if (next <= after) next = after + s.seconds * 1000
    return next
  }

  const start = new Date(after)
  start.setSeconds(0, 0)
  start.setMinutes(start.getMinutes() + 1)

  if (s.kind === 'cron') {
    const limit = new Date(after + 400 * 86400 * 1000)
    for (const d = start; d <= limit; d.setMinutes(d.getMinutes() + 1)) {
      if (cronMatch(s, d)) return d.getTime()
    }
    return null
  }

  const d = new Date(after)
  d.setSeconds(0, 0)
  d.setHours(s.hour, s.minute, 0, 0)
  for (let i = 0; i < 400; i++) {
    if (d.getTime() > after) {
      if (s.kind === 'daily' && s.days.includes(d.getDay())) return d.getTime()
      if (s.kind === 'monthly' && d.getDate() === s.day) return d.getTime()
    }
    d.setDate(d.getDate() + 1)
    d.setHours(s.hour, s.minute, 0, 0)
  }
  return null
}

// How long a job may stay quiet before the shop floor calls it silent.
// Two missed slots plus a grace minute, clamped to sane bounds.
export function silenceWindowSec (scheduleText) {
  let s
  try { s = parseSchedule(scheduleText) } catch { return null }
  if (s.kind === 'manual') return null
  if (s.kind === 'interval') return Math.max(120, Math.round(s.seconds * 2.5))
  const first = nextRun(s, Date.now())
  const second = first === null ? null : nextRun(s, first)
  if (first === null || second === null) return null
  const gap = Math.round((second - first) / 1000)
  return Math.max(3600, gap * 2 + 60)
}
