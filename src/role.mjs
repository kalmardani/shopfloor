import { join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import * as db from './db.mjs'
import { HOME, loadConfig } from './config.mjs'
import { parseSchedule } from './schedule.mjs'
import { runCommand } from './adapters/spawn.mjs'
import { gatherForRole, renderSnapshot } from './sources/google.mjs'

// A role is a job written the way you would advertise it. What the work is
// for, which number says it is going well, which tools it may touch and how
// far, where its own judgement ends, what a day may cost, and how often it
// comes in. The prose goes to the agent. The fields at the top are enforced
// by the shop floor, because a boundary that lives only in a prompt is a
// suggestion.
//
//   ---
//   title: Head of Organic SEO
//   site: https://www.example.com/
//   goal_metric: gsc.clicks
//   budget_usd_day: 2
//   cadence: weekdays 06:40
//   review_day: mon
//   shift: Work one shift and leave your best proposals as drafts.
//   tools:
//     - search_console read sc-domain:example.com
//     - ga4 read 123456789
//     - site read ~/sites/example
//     - web read
//     - drafts write
//   never:
//     - deploy
//     - send outreach email
//   ---
//   The job ad itself, in whatever language the work is done in.

export const GOAL_METRICS = ['gsc.clicks', 'gsc.impressions', 'gsc.ctr', 'gsc.position', 'ga4.organicSessions', 'ga4.sessions']
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

// What each tool means once it reaches the agent. Data sources have no agent
// tool at all, the shop floor reads them and hands over the table.
const TOOLS = {
  search_console: { access: ['read'], agentTools: [], needsTarget: true, gathered: true },
  ga4: { access: ['read'], agentTools: [], needsTarget: true, gathered: true },
  site: { access: ['read'], agentTools: ['Read', 'Grep', 'Glob'], needsTarget: true },
  web: { access: ['read'], agentTools: ['WebSearch', 'WebFetch'] },
  drafts: { access: ['write'], agentTools: [] },
}

// Never available to a role, whatever the user settings on the machine say.
// Deny rules win over allow rules and over a bypass mode, which is the reason
// they are passed even though --tools already leaves these out.
export const FORBIDDEN_AGENT_TOOLS = ['Bash', 'BashOutput', 'KillShell', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Task', 'Agent']

/* ---------- reading a job ad ---------- */

export function parseRole (text) {
  const source = String(text ?? '').replace(/^﻿/, '')
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) throw new Error('a role starts with a block between two --- lines')
  const fields = {}
  let listKey = null
  for (const raw of match[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const item = raw.match(/^\s+-\s+(.*)$/)
    if (item && listKey) { fields[listKey].push(item[1].trim()); continue }
    const pair = raw.match(/^([a-z_]+):\s*(.*)$/)
    if (!pair) throw new Error(`cannot read this line of the role: ${raw.trim().slice(0, 80)}`)
    const [, key, value] = pair
    if (value === '') { fields[key] = []; listKey = key } else { fields[key] = unquote(value.trim()); listKey = null }
  }
  return { fields, body: match[2].trim() }
}

function unquote (v) {
  return (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")) ? v.slice(1, -1) : v
}

export function expandHome (p) {
  if (!p) return p
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p
}

function list (value) {
  if (Array.isArray(value)) return value
  if (!value) return []
  return String(value).split(',').map((s) => s.trim()).filter(Boolean)
}

// Turns the fields into the spec the shop floor runs on, and lists everything
// that is wrong with it in one go rather than one complaint at a time.
export function buildSpec (text, { jobName = null } = {}) {
  const { fields, body } = parseRole(text)
  const errors = []
  const need = (key) => { if (fields[key] === undefined || fields[key] === '' || (Array.isArray(fields[key]) && !fields[key].length)) errors.push(`${key} is missing`) }
  for (const key of ['title', 'goal_metric', 'budget_usd_day', 'cadence', 'tools']) need(key)
  if (!body) errors.push('the job ad itself is missing, the prose under the --- block')

  const tools = list(fields.tools).map((line) => {
    const [name, access, ...rest] = line.split(/\s+/)
    return { name, access, target: rest.length ? expandHome(rest.join(' ')) : null }
  })
  for (const tool of tools) {
    const known = TOOLS[tool.name]
    if (!known) { errors.push(`unknown tool ${tool.name}, known ones are ${Object.keys(TOOLS).join(', ')}`); continue }
    if (!['read', 'write'].includes(tool.access)) { errors.push(`${tool.name} needs an access level, read or write`); continue }
    if (!known.access.includes(tool.access)) {
      errors.push(tool.access === 'write'
        ? `${tool.name} cannot be written to, a role writes only through drafts and the approval gate`
        : `${tool.name} is ${known.access.join(' or ')} only`)
    }
    if (known.needsTarget && !tool.target) errors.push(`${tool.name} needs a target after the access level`)
  }

  const budget = Number(fields.budget_usd_day)
  if (fields.budget_usd_day !== undefined && !(budget > 0)) errors.push('budget_usd_day must be a number above zero')
  if (fields.cadence) { try { parseSchedule(fields.cadence) } catch (err) { errors.push(`cadence: ${err.message}`) } }
  if (fields.goal_metric && !GOAL_METRICS.includes(fields.goal_metric)) errors.push(`goal_metric must be one of ${GOAL_METRICS.join(', ')}`)
  const reviewDay = String(fields.review_day || 'mon').toLowerCase().slice(0, 3)
  if (!WEEKDAYS.includes(reviewDay)) errors.push('review_day must be a weekday, like mon')

  const credentials = readCredentialsField(fields, errors)
  const site = tools.find((t) => t.name === 'site')?.target || null
  const draftsDir = resolve(expandHome(fields.drafts_dir || join(HOME, 'drafts', jobName || slug(fields.title || 'role'))))
  if (site && isInside(draftsDir, resolve(site))) {
    errors.push('drafts_dir is inside the site folder, and a deploy of that folder would publish the drafts')
  }
  const gathered = tools.some((t) => TOOLS[t.name]?.gathered)
  if (gathered && !credentials) errors.push('search_console or ga4 needs a credentials line')
  if (!tools.some((t) => t.name === 'drafts')) errors.push('a role without drafts write has no way to hand work over')

  const maxDrafts = fields.max_drafts_per_run === undefined ? 3 : Number(fields.max_drafts_per_run)
  if (!(maxDrafts >= 1)) errors.push('max_drafts_per_run must be at least 1')

  const spec = {
    title: fields.title || null,
    site: fields.site || null,
    language: fields.language || null,
    goal: fields.goal || null,
    goalMetric: fields.goal_metric || null,
    budgetUsdDay: budget,
    cadence: fields.cadence || null,
    reviewDay,
    timeoutSec: fields.timeout_sec ? Number(fields.timeout_sec) : null,
    model: fields.model || null,
    cwd: expandHome(fields.cwd || site || null),
    cli: fields.cli ? expandHome(fields.cli) : null,
    draftsDir,
    styleCheck: fields.style_check ? expandHome(fields.style_check) : null,
    maxDraftsPerRun: maxDrafts,
    requireData: String(fields.require_data ?? 'true') !== 'false',
    credentialsFile: fields.credentials_file ? expandHome(fields.credentials_file) : null,
    credentials,
    tools,
    never: list(fields.never),
    shift: fields.shift || null,
    body,
  }
  return { spec, errors }
}

function readCredentialsField (fields, errors) {
  if (!fields.credentials) return null
  const [type, ...rest] = String(fields.credentials).split(/\s+/)
  if (type === 'oauth') {
    if (rest.length !== 3) { errors.push('credentials oauth takes three variable names, client id, client secret and refresh token'); return null }
    if (rest.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
      errors.push('credentials oauth takes variable names, never the values themselves')
      return null
    }
    if (!fields.credentials_file) errors.push('credentials oauth needs credentials_file, the env file that holds the variables')
    return { type, clientIdVar: rest[0], clientSecretVar: rest[1], refreshTokenVar: rest[2] }
  }
  if (type === 'service_account') {
    if (rest.length !== 1) { errors.push('credentials service_account takes the path of the key file'); return null }
    return { type, keyFile: expandHome(rest[0]) }
  }
  errors.push('credentials is oauth or service_account')
  return null
}

function isInside (child, parent) {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

export function slug (text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'draft'
}

/* ---------- what the role means for the agent ---------- */

// The claude_local settings a role implies. Applied when the role is hired and
// again on every run, so editing the worker by hand cannot widen the role.
export function agentSettings (spec, { remainingUsd = null } = {}) {
  const tools = [...new Set(spec.tools.flatMap((t) => TOOLS[t.name]?.agentTools || []))]
  const addDirs = spec.tools.filter((t) => t.name === 'site' && t.target && t.target !== spec.cwd).map((t) => t.target)
  const settings = {
    tools,
    allowTools: tools,
    disallowTools: FORBIDDEN_AGENT_TOOLS,
    restricted: true,
    strictMcp: true,
    permissionMode: 'dontAsk',
    addDirs,
    skipPermissions: false,
  }
  if (spec.model) settings.model = spec.model
  if (spec.cwd) settings.cwd = spec.cwd
  if (spec.cli) settings.cli = spec.cli
  if (remainingUsd !== null) settings.maxBudgetUsd = Math.max(0.01, Math.round(remainingUsd * 100) / 100)
  return settings
}

export function workerConfigFromSpec (spec) {
  const { maxBudgetUsd, ...config } = agentSettings(spec)
  return config
}

// The rules of the floor, written for the agent. They say in words what the
// code below enforces anyway, so the agent does not waste a shift finding out.
export function floorRules (spec) {
  const reads = spec.tools.filter((t) => t.access === 'read').map((t) => `${t.name}${t.target ? ' ' + t.target : ''}`)
  return [
    '# How this role works on the shop floor',
    `You are working as ${spec.title}. Shopfloor runs you and enforces the limits below in code.`,
    `- You may read ${reads.join(', ')}. Search Console and GA4 numbers are already gathered for you below, so do not try to reach them yourself.`,
    '- You cannot run commands, edit files, deploy, or send any message. Tools for that are not there.',
    `- Everything you propose is a draft. Each draft is one block, and at most ${spec.maxDraftsPerRun} per shift.`,
    '',
    '::outbox channel=draft subject="<short title>" key=<stable key, for example refresh:/page-path or idea:topic-slug>',
    '<the whole proposal>',
    '::end',
    '',
    '- A draft waits for a person to approve or reject it. Nothing in it reaches the site on its own.',
    '- Use the same key for the same proposal, so a proposal you already made is not queued twice.',
    '- Any other outbox channel, and any ::reply, is refused and shows up in the weekly review.',
    spec.styleCheck ? '- Every draft passes a writing check before anyone sees it. A draft that fails is held back and you are told why next shift.' : null,
    '- Write what you need to remember with ::memory key = value. Keep it short, the numbers are fetched fresh every shift.',
    '- Never invent a number. If the data below says something is not available, say so and work from what is there.',
    spec.never.length ? `- Outside this role, whatever the reason, ${spec.never.join('; ')}.` : null,
  ].filter((l) => l !== null).join('\n')
}

export function briefing (spec, snapshot) {
  return [
    `# Your role, ${spec.title}`,
    spec.body,
    '',
    floorRules(spec),
    '',
    '# Data for this shift',
    renderSnapshot(snapshot),
  ].join('\n')
}

/* ---------- a shift ---------- */

let fetchForRoles = (...args) => globalThis.fetch(...args)

// Tests swap the network for a stub here, the way resetDigestMemory exists.
export function setRoleFetch (fn) { fetchForRoles = fn || ((...args) => globalThis.fetch(...args)) }

// Everything that happens before the agent is called. The numbers are read,
// kept for the weekly review, and put in front of the prompt. When the role
// needs data and none came, the shift ends here at no cost, because an agent
// without its numbers is the one that starts inventing them.
export async function prepareRoleRun ({ job, run, role, remainingUsd = null }) {
  const spec = role.spec
  const snapshot = await gatherForRole(spec, { fetchImpl: fetchForRoles })
  const hasData = !!(snapshot.gsc || snapshot.ga4)
  const wantsData = spec.tools.some((t) => TOOLS[t.name]?.gathered)
  db.addRoleSnapshot({ jobId: job.id, runId: run.id, ok: hasData && !snapshot.errors.length, data: snapshot })
  for (const e of snapshot.errors) {
    db.addEvent({ level: 'warn', kind: 'role:data', jobId: job.id, runId: run.id, message: `${e.source}: ${e.message}`.slice(0, 300) })
  }

  if (wantsData && !hasData && spec.requireData) {
    const why = `no data for this shift. ${snapshot.errors.map((e) => `${e.source}: ${e.message}`).join(' ') || 'nothing came back'}`
    return { stop: true, result: { exitCode: 1, stdout: '', stderr: why, costUsd: 0, summary: why.slice(0, 400) } }
  }

  // A draft the writing check held back is already in the memory block under
  // held_back, so it reaches the agent without a second channel.
  return {
    stop: false,
    payload: {
      ...agentSettings(spec, { remainingUsd }),
      prompt: job.payload?.prompt || spec.shift || 'Work one shift in this role. Read the data, look at the pages it points to, and leave your best proposals as drafts. End with ::memory notes about what you would look at next time.',
      briefing: briefing(spec, snapshot),
    },
  }
}

// What a role run said back, screened against the role before anything is
// stored. Drafts that pass go straight in front of the gate, everything else
// is refused and written down, so the review can say what was attempted.
export async function screenRoleOutput ({ job, run, role, directives, config = loadConfig() }) {
  const spec = role.spec
  const refused = []
  const queued = []
  const held = []

  for (const reply of directives.replies) {
    refused.push(`reply to ${reply.job || 'itself'}: ${reply.message.slice(0, 80)}`)
  }

  let drafts = 0
  for (const entry of directives.outbox) {
    if (entry.channel !== 'draft') {
      refused.push(`outbox on ${entry.channel}${entry.recipient ? ' to ' + entry.recipient : ''}: ${(entry.subject || entry.body).slice(0, 80)}`)
      continue
    }
    if (!entry.body) continue
    if (++drafts > spec.maxDraftsPerRun) {
      refused.push(`draft over the limit of ${spec.maxDraftsPerRun}: ${(entry.subject || '').slice(0, 80)}`)
      continue
    }
    const style = await checkStyle(spec, `${entry.subject || ''}\n\n${entry.body}`)
    const { entry: stored, duplicate } = db.addOutboxEntry({
      jobId: job.id,
      runId: run.id,
      channel: 'draft',
      subject: entry.subject,
      body: entry.body.slice(0, config.keepRunOutputChars || 20000),
      dedupeKey: entry.dedupeKey,
      status: 'held',
      note: style.ok ? null : `held back by the writing check. ${style.problems}`.slice(0, 1000),
    })
    if (duplicate) continue
    if (!style.ok) {
      held.push({ id: stored.id, subject: stored.subject, problems: style.problems })
      db.addEvent({ level: 'warn', kind: 'role:style', jobId: job.id, runId: run.id, message: `${stored.subject || stored.id.slice(0, 8)}: ${style.problems}`.slice(0, 300) })
      continue
    }
    // The gate is asked now, not when the outbox is next dispatched, because a
    // quiet shop floor never dispatches and a draft must still reach a person.
    const approval = db.createApproval({
      runId: run.id,
      jobId: job.id,
      question: `Draft from ${job.name}. ${(stored.subject || stored.body.split('\n')[0]).slice(0, 160)}`,
      kind: 'outbox',
      outboxId: stored.id,
    })
    db.updateOutboxEntry(stored.id, { approvalId: approval.id })
    db.addEvent({ level: 'info', kind: 'outbox:queued', jobId: job.id, runId: run.id, message: `draft waiting for a decision (${approval.id.slice(0, 8)})` })
    queued.push(stored)
  }

  for (const what of refused) {
    db.addEvent({ level: 'warn', kind: 'role:refused', jobId: job.id, runId: run.id, message: what.slice(0, 300) })
  }

  // The next shift hears what was held back, in the job's own memory, so the
  // agent learns the rule from its own draft rather than from a longer prompt.
  if (held.length) {
    db.setMemory({ jobId: job.id, key: 'held_back', value: held.map((h) => `${h.subject || h.id.slice(0, 8)}: ${h.problems}`).join(' | ').slice(0, config.memoryValueChars || 2000), source: 'shopfloor', runId: run.id })
  } else if (queued.length) {
    db.deleteMemory(job.id, 'held_back')
  }

  return { directives: { ...directives, outbox: [], replies: [] }, queued, held, refused }
}

// The writing check is a command, so the rules stay with whoever owns them.
// Text on standard input, exit 0 when it is clean, the problems on stdout when
// it is not. A check that cannot run holds the draft, it never waves it through.
export async function checkStyle (spec, text) {
  if (!spec.styleCheck) return { ok: true, problems: '' }
  const result = await runCommand({ command: spec.styleCheck, input: text, timeoutSec: 30 })
  if (result.exitCode === 0) return { ok: true, problems: '' }
  const problems = (result.stdout || result.stderr || `the writing check ended with ${result.exitCode}`).trim().replace(/\s+/g, ' ')
  return { ok: false, problems: problems.slice(0, 600) }
}

/* ---------- hiring ---------- */

// One role, one worker of its own, one job. The worker carries the day cap so
// the budget gate that is already here applies without a second mechanism.
// A new role starts switched off, because a hire is not a go.
export function hireRole ({ name, text }) {
  const { spec, errors } = buildSpec(text, { jobName: name })
  if (errors.length) throw new Error(`the role cannot be hired yet\n- ${errors.join('\n- ')}`)
  if (db.getJob(name)) throw new Error(`there is already a job called ${name}`)
  // A role gets a worker of its own, so its cap and its tools are nobody else's.
  if (db.getWorker(name)) throw new Error(`there is already a worker called ${name}, a role needs its own`)
  const worker = db.createWorker({
    name,
    role: spec.title,
    adapter: 'claude_local',
    config: workerConfigFromSpec(spec),
    maxUsdDay: spec.budgetUsdDay,
  })
  const job = db.createJob({
    workerId: worker.id,
    name,
    goal: spec.goal || `${spec.title}, measured by ${spec.goalMetric}`,
    schedule: spec.cadence,
    timeoutSec: spec.timeoutSec,
    enabled: false,
  })
  db.setRole({ jobId: job.id, source: text, spec })
  db.addEvent({ level: 'info', kind: 'role:hired', jobId: job.id, message: `${spec.title}, ${spec.budgetUsdDay} USD a day, ${spec.cadence}` })
  return { job: db.getJob(job.id), worker: db.getWorker(worker.id), spec }
}

// A changed job ad replaces the old one and the worker settings follow it.
export function updateRole ({ job, text }) {
  const { spec, errors } = buildSpec(text, { jobName: job.name })
  if (errors.length) throw new Error(`the role was not changed\n- ${errors.join('\n- ')}`)
  const worker = db.getWorker(job.worker_id)
  db.updateWorker(worker.id, { role: spec.title, config: { ...worker.config, ...workerConfigFromSpec(spec) }, maxUsdDay: spec.budgetUsdDay })
  db.updateJob(job.id, { schedule: spec.cadence, goal: spec.goal || job.goal, timeoutSec: spec.timeoutSec ?? job.timeout_sec })
  const role = db.setRole({ jobId: job.id, source: text, spec })
  db.addEvent({ level: 'info', kind: 'role:changed', jobId: job.id, message: `version ${role.version}` })
  return role
}
