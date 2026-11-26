// A run talks back to the shop floor through its own output. Nothing else is
// needed, no socket and no extra protocol, because stdout is the one channel
// every adapter already has.
//
//   ::memory last_seen = 4812
//   ::pointer notes = ~/Developer/notes/2026-11.md
//   ::forget last_seen
//   ::reply other-job look at the new file
//   ::outbox channel=email to=dani@example.com subject=Weekly letter
//   Dear Dani,
//   the week went well.
//   ::end
//
// A directive is only read when it starts a line, so ordinary prose about
// memory or an outbox is never mistaken for an instruction.

const ATTR = /(\w+)=("[^"]*"|'[^']*'|\S+)/g

export function parseDirectives (text = '') {
  const result = { memory: [], forget: [], replies: [], outbox: [], errors: [] }
  const lines = String(text ?? '').split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.startsWith('::')) continue
    const [, verb, rest = ''] = line.match(/^::(\w+)\s*(.*)$/) || []
    if (!verb) continue

    if (verb === 'memory' || verb === 'pointer') {
      const pair = rest.match(/^([\w.:-]+)\s*=\s*([\s\S]*)$/)
      if (!pair) { result.errors.push(`${verb} needs a key and a value: ${line.slice(0, 80)}`); continue }
      result.memory.push({ key: pair[1], value: pair[2].trim(), kind: verb === 'pointer' ? 'pointer' : 'note' })
      continue
    }

    if (verb === 'forget') {
      const key = rest.trim()
      if (key) result.forget.push(key)
      else result.errors.push('forget needs a key')
      continue
    }

    if (verb === 'reply') {
      const match = rest.match(/^(\S+)\s*([\s\S]*)$/)
      if (!match) { result.errors.push('reply needs a job and a message'); continue }
      result.replies.push({ job: match[1] === 'self' ? null : match[1], message: match[2].trim() })
      continue
    }

    if (verb === 'outbox') {
      const attrs = {}
      for (const [, key, raw] of rest.matchAll(ATTR)) attrs[key] = unquote(raw)
      const body = []
      let closed = false
      while (++i < lines.length) {
        if (lines[i].trim() === '::end') { closed = true; break }
        body.push(lines[i])
      }
      if (!closed) result.errors.push('an outbox block was never closed with ::end')
      result.outbox.push({
        channel: attrs.channel || 'note',
        recipient: attrs.to || attrs.recipient || null,
        subject: attrs.subject || null,
        dedupeKey: attrs.key || attrs.dedupe || null,
        body: body.join('\n').trim(),
      })
      continue
    }
  }

  return result
}

function unquote (value) {
  const text = String(value)
  return (text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))
    ? text.slice(1, -1)
    : text
}

export const directiveHelp = [
  '::memory <key> = <value>            remember something the next run cannot look up again',
  '::pointer <key> = <where>           remember where to look instead of the thing itself',
  '::forget <key>                      drop one memory entry',
  '::reply <job|self> <message>        put work back in an inbox',
  '::outbox channel=.. to=.. subject=..',
  '<body lines>',
  '::end                               leave finished work in the outbox',
].join('\n')
