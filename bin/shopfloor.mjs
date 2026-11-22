#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as db from '../src/db.mjs'
import { loadConfig, saveConfig, HOME, DB_PATH, CONFIG_PATH } from '../src/config.mjs'
import { startJob } from '../src/runner.mjs'
import { serve } from '../src/server.mjs'
import { serveScheduler, tick } from '../src/scheduler.mjs'
import { buildDigest, notify } from '../src/digest.mjs'
import { shopHealth, jobHealth, humanAge } from '../src/health.mjs'
import { adapterNames, getAdapter } from '../src/adapters/index.mjs'

const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
const argv = process.argv.slice(2)
const { positional, flags } = parseArgs(argv)
const command = positional[0] || 'help'

const HELP = `shopfloor ${pkg.version} — a shop floor for the agents you already run

  shopfloor init                        create the home directory, database and config
  shopfloor serve [--no-scheduler]      web interface on http://127.0.0.1:7420 plus the tick loop
  shopfloor tick                        run one scheduler pass and stop (for cron or launchd)

  shopfloor worker add <name> --adapter <${adapterNames.join('|')}> [options]
        --command "<shell command>"     process adapter
        --prompt "<text>"               claude_local and codex_local
        --model <id> --cwd <dir> --cap <usd/day> --role "<text>"
        --allow-tools Read,Bash         claude_local tool allowlist
        --skip-permissions              claude_local headless, no allow prompts (know what it means)
        --url <webhook>                 http adapter
  shopfloor worker list | worker rm <name>

  shopfloor job add <name> --worker <name> --schedule "<schedule>" [options]
        --prompt | --command            overrides the worker default for this job
        --goal "<why it exists>"  --timeout <sec>  --approval  --silence <sec>  --off
  shopfloor job list | job rm <name> | job on <name> | job off <name>
  shopfloor job set <name> --schedule "<schedule>" [--goal ...] [--approval|--no-approval]

  shopfloor run <job> [--force]         start a job now
  shopfloor runs [job] [--status ok|fail|...] [--limit 20]
  shopfloor show <run-id>               full output of one run
  shopfloor approvals | approve <id> [--note ...] | reject <id> [--note ...]

  shopfloor doctor                      what stopped quietly, what is waiting, what it cost
  shopfloor digest [--notify]           the morning text, optionally through notifyCommand
  shopfloor heartbeat <job>             the dead man's switch URL for an outside process
  shopfloor config [key value]          show or change a setting
  shopfloor import <file.json>          workers and jobs from one file

Schedules: every 15m · daily 07:30 · weekdays 08:00 · mon 09:00 · monthly 1 09:00 · */15 * * * * · manual
Home: ${HOME}
`

try {
  await main()
} catch (err) {
  console.error(`error: ${err.message}`)
  process.exitCode = 1
} finally {
  if (!['serve'].includes(command)) db.close()
}

async function main () {
  switch (command) {
    case 'help': case '--help': case '-h': return console.log(HELP)
    case 'version': case '--version': case '-v': return console.log(pkg.version)
    case 'init': return cmdInit()
    case 'serve': return cmdServe()
    case 'tick': return cmdTick()
    case 'worker': return cmdWorker()
    case 'job': return cmdJob()
    case 'run': return cmdRun()
    case 'runs': return cmdRuns()
    case 'show': return cmdShow()
    case 'approvals': return cmdApprovals()
    case 'approve': return cmdDecide('approved')
    case 'reject': return cmdDecide('rejected')
    case 'doctor': return cmdDoctor()
    case 'digest': return cmdDigest()
    case 'heartbeat': case 'hb': return cmdHeartbeat()
    case 'config': return cmdConfig()
    case 'import': return cmdImport()
    default: throw new Error(`unknown command: ${command}. Try shopfloor help`)
  }
}

/* ---------- commands ---------- */

function cmdInit () {
  db.open()
  const config = saveConfig({})
  console.log(`home      ${HOME}`)
  console.log(`database  ${DB_PATH}`)
  console.log(`config    ${CONFIG_PATH}`)
  console.log(`web       http://${config.host}:${config.port} (shopfloor serve)`)
  console.log('')
  console.log('Next: shopfloor worker add my-script --adapter process --command "node ~/Developer/thing/run.mjs"')
}

async function cmdServe () {
  const config = loadConfig()
  if (flags.port) config.port = Number(flags.port)
  if (flags.host) config.host = String(flags.host)
  db.open()
  await serve({ config })
  if (flags['no-scheduler']) {
    console.log('scheduler is off, this process only serves the web interface')
    return
  }
  await serveScheduler({ config })
}

async function cmdTick () {
  const result = await tick({ log: console.log })
  if (!result.started.length && !result.skipped.length) console.log('nothing was due')
  for (const s of result.started) console.log(`started ${s.job}${s.status ? ' → ' + s.status : ''}`)
  for (const s of result.skipped) console.log(`skipped ${s.job}: ${s.why}`)
}

function cmdWorker () {
  const action = positional[1]
  if (action === 'add') {
    const name = need(positional[2], 'worker name')
    const adapter = String(need(flags.adapter, '--adapter'))
    getAdapter(adapter)
    const config = {}
    if (flags.command) config.command = String(flags.command)
    if (flags.prompt) config.prompt = String(flags.prompt)
    if (flags.cwd) config.cwd = resolveHome(String(flags.cwd))
    if (flags.model) config.model = String(flags.model)
    if (flags.url) config.url = String(flags.url)
    if (flags['allow-tools']) config.allowTools = String(flags['allow-tools']).split(',').map((s) => s.trim()).filter(Boolean)
    if (flags['skip-permissions']) config.skipPermissions = true
    if (flags.sandbox) config.sandbox = String(flags.sandbox)
    if (flags['system-prompt']) config.systemPrompt = String(flags['system-prompt'])
    const worker = db.createWorker({
      name, adapter, config,
      role: flags.role ? String(flags.role) : null,
      maxUsdDay: flags.cap === undefined ? null : Number(flags.cap),
    })
    return console.log(`worker ${worker.name} (${worker.adapter}) added`)
  }
  if (action === 'rm') {
    const worker = need(db.getWorker(positional[2]), `worker ${positional[2]}`)
    db.deleteWorker(worker.id)
    return console.log(`worker ${worker.name} removed with its jobs`)
  }
  const workers = db.listWorkers()
  if (!workers.length) return console.log('no workers yet')
  for (const w of workers) {
    console.log(`${w.enabled ? ' ' : '·'} ${w.name.padEnd(22)} ${w.adapter.padEnd(13)} ${w.max_usd_day ? w.max_usd_day + ' USD/day' : ''} ${w.role || ''}`)
    const detail = w.config.command || w.config.url || (w.config.prompt || '').slice(0, 60)
    if (detail) console.log(`    ${detail}`)
  }
}

function cmdJob () {
  const action = positional[1]
  if (action === 'add') {
    const name = need(positional[2], 'job name')
    const workerName = String(need(flags.worker, '--worker'))
    const worker = need(db.getWorker(workerName), `worker ${workerName}`)
    const schedule = String(need(flags.schedule, '--schedule'))
    const payload = {}
    if (flags.prompt) payload.prompt = String(flags.prompt)
    if (flags.command) payload.command = String(flags.command)
    if (flags.cwd) payload.cwd = resolveHome(String(flags.cwd))
    if (flags.model) payload.model = String(flags.model)
    const job = db.createJob({
      workerId: worker.id, name, schedule, payload,
      goal: flags.goal ? String(flags.goal) : null,
      timeoutSec: flags.timeout ? Number(flags.timeout) : null,
      requiresApproval: !!flags.approval,
      silenceSec: flags.silence === undefined ? undefined : Number(flags.silence),
      enabled: !flags.off,
    })
    const next = job.next_at ? new Date(job.next_at).toLocaleString() : 'never on its own'
    return console.log(`job ${job.name} added (${job.schedule}), next ${next}${job.requires_approval ? ', behind an approval gate' : ''}`)
  }
  if (action === 'rm') {
    const job = need(db.getJob(positional[2]), `job ${positional[2]}`)
    db.deleteJob(job.id)
    return console.log(`job ${job.name} removed`)
  }
  if (action === 'on' || action === 'off') {
    const job = need(db.getJob(positional[2]), `job ${positional[2]}`)
    const updated = db.updateJob(job.id, { enabled: action === 'on' })
    return console.log(`job ${updated.name} is ${action === 'on' ? 'on, next ' + new Date(updated.next_at).toLocaleString() : 'off'}`)
  }
  if (action === 'set') {
    const job = need(db.getJob(positional[2]), `job ${positional[2]}`)
    const patch = {}
    if (flags.schedule) patch.schedule = String(flags.schedule)
    if (flags.goal) patch.goal = String(flags.goal)
    if (flags.timeout) patch.timeoutSec = Number(flags.timeout)
    if (flags.silence) patch.silenceSec = Number(flags.silence)
    if (flags.approval) patch.requiresApproval = true
    if (flags['no-approval']) patch.requiresApproval = false
    const updated = db.updateJob(job.id, patch)
    return console.log(`job ${updated.name} updated (${updated.schedule})`)
  }
  const jobs = db.listJobs()
  if (!jobs.length) return console.log('no jobs yet')
  for (const job of jobs) {
    const health = jobHealth(job)
    const last = health.lastRun
    const mark = health.state === 'attention' ? '!' : job.enabled ? ' ' : '·'
    console.log(`${mark} ${job.name.padEnd(26)} ${job.schedule.padEnd(16)} ${(last ? last.status : 'never').padEnd(18)} next ${job.next_at ? new Date(job.next_at).toLocaleString() : '—'}`)
    for (const p of health.problems) console.log(`    ${p.kind}: ${p.message}`)
  }
}

async function cmdRun () {
  const job = need(db.getJob(positional[1]), `job ${positional[1]}`)
  const outcome = await startJob(job, { trigger: 'cli', force: !!flags.force })
  if (!outcome.started && outcome.approval) return console.log(`waiting for a decision: shopfloor approve ${outcome.approval.id.slice(0, 8)}`)
  if (!outcome.started) return console.log(`not started: ${outcome.blocked}`)
  const run = outcome.run
  console.log(`${run.status}${run.exit_code === null ? '' : ' (exit ' + run.exit_code + ')'} in ${Math.max(1, Math.round(((run.ended_at || Date.now()) - (run.started_at || Date.now())) / 1000))}s${run.cost_usd ? ', ' + run.cost_usd.toFixed(2) + ' USD' : ''}`)
  if (run.stdout) console.log('\n' + run.stdout.trim().slice(-4000))
  if (run.stderr) console.error('\n' + run.stderr.trim().slice(-2000))
  if (run.status !== 'ok') process.exitCode = 1
}

function cmdRuns () {
  const jobRef = positional[1]
  const job = jobRef ? need(db.getJob(jobRef), `job ${jobRef}`) : null
  const runs = db.listRuns({ jobId: job?.id || null, status: flags.status ? String(flags.status) : null, limit: Number(flags.limit || 20) })
  if (!runs.length) return console.log('no runs')
  for (const r of runs) {
    const took = r.started_at && r.ended_at ? Math.max(1, Math.round((r.ended_at - r.started_at) / 1000)) + 's' : '—'
    console.log(`${r.id.slice(0, 8)}  ${new Date(r.queued_at).toLocaleString().padEnd(22)} ${(r.job_name || '—').padEnd(24)} ${r.status.padEnd(18)} ${took.padStart(6)} ${r.cost_usd ? r.cost_usd.toFixed(2) + ' USD' : ''} ${(r.summary || '').slice(0, 60)}`)
  }
}

function cmdShow () {
  const prefix = need(positional[1], 'run id')
  const run = db.listRuns({ limit: 500 }).find((r) => r.id.startsWith(prefix))
  if (!run) throw new Error(`no run starts with ${prefix}`)
  const full = db.getRun(run.id)
  console.log(`job      ${run.job_name || '—'}`)
  console.log(`status   ${full.status}${full.exit_code === null ? '' : ' (exit ' + full.exit_code + ')'}`)
  console.log(`queued   ${new Date(full.queued_at).toLocaleString()}`)
  console.log(`ended    ${full.ended_at ? new Date(full.ended_at).toLocaleString() : '—'}`)
  console.log(`cost     ${Number(full.cost_usd || 0).toFixed(2)} USD`)
  if (full.stdout) console.log(`\n--- output ---\n${full.stdout}`)
  if (full.stderr) console.log(`\n--- errors ---\n${full.stderr}`)
}

function cmdApprovals () {
  const list = db.listApprovals({ state: flags.state ? String(flags.state) : 'pending' })
  if (!list.length) return console.log('nothing is waiting for a decision')
  for (const a of list) {
    console.log(`${a.id.slice(0, 8)}  ${(a.job_name || a.job_id).padEnd(26)} asked ${humanAge(Date.now() - a.requested_at)} ago  ${a.question || ''}`)
  }
}

async function cmdDecide (state) {
  const id = need(positional[1], 'approval id')
  const approval = db.decideApproval(id, state, { by: 'cli', note: flags.note ? String(flags.note) : null })
  db.addEvent({ level: 'info', kind: `approval:${state}`, jobId: approval.job_id, runId: approval.run_id, message: String(flags.note || state) })
  if (state === 'rejected') {
    db.updateRun(approval.run_id, { status: 'rejected', endedAt: Date.now(), summary: String(flags.note || 'rejected by a human') })
    return console.log(`rejected ${approval.job_name}`)
  }
  console.log(`approved ${approval.job_name}, running now`)
  const { runApproved } = await import('../src/runner.mjs')
  const run = await runApproved(approval.id)
  console.log(`${run.status}${run.cost_usd ? ', ' + run.cost_usd.toFixed(2) + ' USD' : ''}`)
  if (run.stdout) console.log('\n' + run.stdout.trim().slice(-4000))
}

function cmdDoctor () {
  const health = shopHealth()
  const config = loadConfig()
  console.log(`home ${HOME}`)
  console.log(`jobs ${health.jobs.length}, workers ${db.listWorkers().length}, spent today ${health.spentToday.toFixed(2)} USD of ${config.maxUsdPerDay} USD`)
  console.log('')
  if (!health.attention.length) console.log('Every job is inside its window.')
  for (const item of health.attention) {
    console.log(`! ${item.job.name}`)
    for (const p of item.problems) console.log(`    ${p.kind}: ${p.message}`)
  }
  if (health.pendingApprovals.length) {
    console.log('')
    console.log(`Waiting for a decision: ${health.pendingApprovals.map((a) => a.job_name).join(', ')}`)
  }
  if (health.running.length) {
    console.log('')
    console.log(`Running now: ${health.running.map((r) => r.job_name).join(', ')}`)
  }
  const stale = db.listRuns({ status: 'lost', limit: 1 })
  if (stale.length) console.log(`\nA run was left open by an earlier scheduler, last at ${new Date(stale[0].queued_at).toLocaleString()}.`)
  if (health.attention.length) process.exitCode = 1
}

async function cmdDigest () {
  const text = buildDigest({ hours: Number(flags.hours || 24) })
  console.log(text)
  if (flags.notify) {
    const sent = await notify(text)
    console.log(sent ? '(sent through notifyCommand)' : '(no notifyCommand in the config)')
  }
}

function cmdHeartbeat () {
  const job = need(db.getJob(positional[1]), `job ${positional[1]}`)
  const config = loadConfig()
  const url = `http://${config.host}:${config.port}/hb/${job.heartbeat_token}`
  const beat = db.getHeartbeat(job.id)
  console.log(url)
  console.log('')
  console.log(`Put this at the end of whatever runs outside the shop floor:`)
  console.log(`  curl -fsS -m 5 ${url} > /dev/null`)
  console.log('')
  console.log(beat ? `last ping ${humanAge(Date.now() - beat.last_at)} ago` : 'no ping yet')
}

function cmdConfig () {
  const key = positional[1]
  const value = positional[2]
  if (!key) return console.log(JSON.stringify(loadConfig(), null, 2))
  if (value === undefined) return console.log(JSON.stringify(loadConfig()[key] ?? null))
  const parsed = value === 'null' ? null : value === 'true' ? true : value === 'false' ? false : Number.isNaN(Number(value)) ? value : Number(value)
  const next = saveConfig({ [key]: parsed })
  console.log(`${key} = ${JSON.stringify(next[key])}`)
}

function cmdImport () {
  const file = need(positional[1], 'file')
  const data = JSON.parse(readFileSync(resolveHome(file), 'utf8'))
  let workers = 0
  let jobs = 0
  for (const w of data.workers || []) {
    if (db.getWorker(w.name)) { console.log(`worker ${w.name} is already here, left alone`); continue }
    db.createWorker({ name: w.name, role: w.role ?? null, adapter: w.adapter, config: w.config || {}, maxUsdDay: w.maxUsdDay ?? null, enabled: w.enabled ?? true })
    workers++
  }
  for (const j of data.jobs || []) {
    if (db.getJob(j.name)) { console.log(`job ${j.name} is already here, left alone`); continue }
    const worker = need(db.getWorker(j.worker), `worker ${j.worker}`)
    db.createJob({
      workerId: worker.id, name: j.name, goal: j.goal ?? null, schedule: j.schedule,
      payload: j.payload || {}, timeoutSec: j.timeoutSec ?? null, requiresApproval: !!j.requiresApproval,
      silenceSec: j.silenceSec, enabled: j.enabled ?? true,
    })
    jobs++
  }
  console.log(`imported ${workers} worker(s) and ${jobs} job(s)`)
  if (data.config) { saveConfig(data.config); console.log('config updated') }
}

/* ---------- helpers ---------- */

function parseArgs (args) {
  const positional = []
  const flags = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=')
      if (inline !== undefined) { flags[key] = inline; continue }
      const next = args[i + 1]
      if (next === undefined || next.startsWith('--')) flags[key] = true
      else { flags[key] = next; i++ }
    } else positional.push(arg)
  }
  return { positional, flags }
}

function need (value, what) {
  if (value === undefined || value === null || value === false || value === '') throw new Error(`${what} is missing`)
  return value
}

function resolveHome (p) {
  return p.startsWith('~') ? join(process.env.HOME || '', p.slice(1)) : p
}
