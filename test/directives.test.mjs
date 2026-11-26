import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDirectives } from '../src/directives.mjs'

test('a run writes memory, pointers and forgetting into its own output', () => {
  const out = parseDirectives([
    'I read the folder and found two new files.',
    '::memory last_seen = 4812',
    '::pointer notes = ~/Developer/notes/2026-11.md',
    '::forget old_key',
  ].join('\n'))
  assert.deepEqual(out.memory, [
    { key: 'last_seen', value: '4812', kind: 'note' },
    { key: 'notes', value: '~/Developer/notes/2026-11.md', kind: 'pointer' },
  ])
  assert.deepEqual(out.forget, ['old_key'])
  assert.equal(out.errors.length, 0)
})

test('an outbox block keeps its attributes and its whole body', () => {
  const out = parseDirectives([
    '::outbox channel=email to=dani@example.com subject="Weekly letter" key=week-48',
    'Dear Dani,',
    '',
    'the week went well.',
    '::end',
    'and that is all I did.',
  ].join('\n'))
  assert.equal(out.outbox.length, 1)
  const entry = out.outbox[0]
  assert.equal(entry.channel, 'email')
  assert.equal(entry.recipient, 'dani@example.com')
  assert.equal(entry.subject, 'Weekly letter')
  assert.equal(entry.dedupeKey, 'week-48')
  assert.equal(entry.body, 'Dear Dani,\n\nthe week went well.')
})

test('a block nobody closed is reported instead of swallowing the rest', () => {
  const out = parseDirectives('::outbox channel=note\nhalf a letter')
  assert.match(out.errors[0], /never closed/)
  assert.equal(out.outbox[0].body, 'half a letter')
})

test('a reply names a job, or itself', () => {
  const out = parseDirectives('::reply other-job the new file is on disk\n::reply self look again in an hour')
  assert.deepEqual(out.replies, [
    { job: 'other-job', message: 'the new file is on disk' },
    { job: null, message: 'look again in an hour' },
  ])
})

test('prose about a directive is not a directive', () => {
  const out = parseDirectives([
    'The agent may answer with ::memory key = value to remember something.',
    'Nothing here starts a line with the marker, so nothing is read.',
  ].join('\n'))
  assert.equal(out.memory.length, 0)
  assert.equal(out.errors.length, 0)
})

test('a key without a value is an error, not a silent write', () => {
  const out = parseDirectives('::memory last_seen\n::forget')
  assert.equal(out.memory.length, 0)
  assert.equal(out.errors.length, 2)
})
