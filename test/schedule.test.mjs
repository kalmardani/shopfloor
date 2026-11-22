import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSchedule, nextRun, silenceWindowSec, ScheduleError } from '../src/schedule.mjs'

test('plain words are read as schedules', () => {
  assert.equal(parseSchedule('every 15m').kind, 'interval')
  assert.equal(parseSchedule('every 15m').seconds, 900)
  assert.equal(parseSchedule('every 2h').seconds, 7200)
  assert.equal(parseSchedule('daily 07:30').hour, 7)
  assert.deepEqual(parseSchedule('weekdays 08:00').days, [1, 2, 3, 4, 5])
  assert.deepEqual(parseSchedule('sat 18:00').days, [6])
  assert.equal(parseSchedule('monthly 1 09:00').day, 1)
  assert.equal(parseSchedule('manual').kind, 'manual')
  assert.equal(parseSchedule('*/15 * * * *').kind, 'cron')
})

test('a schedule nobody can read is rejected on the spot', () => {
  for (const bad of ['', 'sometimes', 'every 0m', 'every 3s', 'daily 25:00', 'daily 07:99', 'monthly 31 09:00', '99 * * * *', '* * *']) {
    assert.throws(() => parseSchedule(bad), ScheduleError, `should reject: ${bad}`)
  }
})

test('an interval counts from the last run, not from the tick', () => {
  const now = Date.UTC(2026, 10, 22, 12, 0, 0)
  const lastRun = now - 10 * 60_000
  assert.equal(nextRun('every 15m', now, lastRun), lastRun + 15 * 60_000)
  const overdue = now - 60 * 60_000
  assert.ok(nextRun('every 15m', now, overdue) > now, 'a long overdue job is not scheduled into the past')
})

test('a daily schedule lands on the next matching day', () => {
  const sunday = new Date(2026, 10, 22, 12, 0, 0).getTime() // 2026-11-22 is a Sunday
  const next = new Date(nextRun('weekdays 08:00', sunday))
  assert.equal(next.getDay(), 1)
  assert.equal(next.getHours(), 8)
  const monday = new Date(nextRun('mon 09:00', sunday))
  assert.equal(monday.getDay(), 1)
  assert.equal(monday.getHours(), 9)
})

test('cron steps and ranges fire when they should', () => {
  const at = new Date(2026, 10, 22, 12, 7, 30).getTime()
  const quarter = new Date(nextRun('*/15 * * * *', at))
  assert.equal(quarter.getMinutes(), 15)
  const workdayMorning = new Date(nextRun('0 7 * * 1-5', at))
  assert.equal(workdayMorning.getHours(), 7)
  assert.ok([1, 2, 3, 4, 5].includes(workdayMorning.getDay()))
})

test('a manual schedule never fires on its own', () => {
  assert.equal(nextRun('manual'), null)
  assert.equal(silenceWindowSec('manual'), null)
})

test('the silence window is wider than the gap it watches', () => {
  assert.equal(silenceWindowSec('every 1h'), 9000)
  assert.ok(silenceWindowSec('daily 07:30') > 86400)
  assert.ok(silenceWindowSec('mon 09:00') > 7 * 86400)
})
