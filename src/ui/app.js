// The whole interface. No build step, no framework, no dependency: the file
// the browser loads is the file in the repository.
const token = new URLSearchParams(location.search).get('token')
const api = async (path, options = {}) => {
  const url = path + (token ? (path.includes('?') ? '&' : '?') + 'token=' + token : '')
  const res = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}

const el = (id) => document.getElementById(id)
const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const ago = (ts) => {
  if (!ts) return 'never'
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 90) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 90) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}
const when = (ts) => ts ? new Date(ts).toLocaleString() : '—'
const money = (v) => `${Number(v || 0).toFixed(2)} USD`

let state = null
let view = 'board'
let runFilter = null

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    view = tab.dataset.view
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-on', t === tab))
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${view}`))
    render()
    if (view === 'digest') loadDigest()
  })
})

el('sheet').addEventListener('click', (event) => {
  if (event.target.id === 'sheet' || event.target.classList.contains('sheet-close')) closeSheet()
})
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet() })

function openSheet (html) {
  el('sheet-body').innerHTML = html
  el('sheet').classList.remove('hidden')
}
function closeSheet () { el('sheet').classList.add('hidden') }

async function refresh () {
  try {
    state = await api('/api/state')
    render()
  } catch (err) {
    el('foot-note').textContent = `cannot reach the server: ${err.message}`
  }
}

function render () {
  if (!state) return
  const attention = state.jobs.filter((j) => j.state === 'attention')
  const meter = el('meter-attention')
  meter.textContent = attention.length ? `${attention.length} ${attention.length === 1 ? 'job needs' : 'jobs need'} attention` : 'all inside window'
  meter.className = 'meter ' + (attention.length ? 'bad' : 'good')
  el('meter-spend').textContent = `${money(state.spentToday)} today of ${state.config.maxUsdPerDay} USD`
  el('meter-clock').textContent = `tick ${state.config.tickSeconds}s · ${new Date(state.at).toLocaleTimeString()}`
  const badge = el('badge-approvals')
  badge.textContent = state.approvals.length
  badge.classList.toggle('hidden', state.approvals.length === 0)

  if (view === 'board') renderBoard()
  if (view === 'approvals') renderApprovals()
  if (view === 'runs') renderRuns()
  if (view === 'workers') renderWorkers()
}

function renderBoard () {
  const jobs = [...state.jobs].sort((a, b) => (a.state === b.state ? a.name.localeCompare(b.name) : a.state === 'attention' ? -1 : 1))
  el('view-board').innerHTML = jobs.length === 0
    ? `<p class="empty">No jobs yet. Add one with <code>shopfloor job add</code>.</p>`
    : `<div class="cards">${jobs.map(jobCard).join('')}</div>`
  el('view-board').querySelectorAll('[data-run]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true
      btn.textContent = 'running…'
      try {
        const out = await api(`/api/jobs/${btn.dataset.run}/run`, { method: 'POST', body: {} })
        await refresh()
        if (out.run) showRun(out.run.id)
      } catch (err) { alert(err.message) } finally { btn.disabled = false; btn.textContent = 'Run now' }
    })
  })
  el('view-board').querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/jobs/${btn.dataset.toggle}`, { method: 'PATCH', body: { enabled: btn.dataset.enabled !== 'true' } })
      refresh()
    })
  })
  el('view-board').querySelectorAll('[data-history]').forEach((btn) => {
    btn.addEventListener('click', () => {
      runFilter = btn.dataset.history
      document.querySelector('.tab[data-view="runs"]').click()
    })
  })
}

function jobCard (job) {
  const last = job.lastRun
  return `<article class="card">
    <div class="row">
      <h3><span class="dot ${esc(job.state)}"></span>${esc(job.name)}</h3>
      <span class="tag ${last ? esc(last.status) : ''}">${last ? esc(last.status) : 'no run yet'}</span>
    </div>
    <div class="meta">${esc(job.worker || '?')} · ${esc(job.adapter || '?')} · ${esc(job.schedule)}${job.requires_approval ? ' · approval gate' : ''}</div>
    <div class="meta">last ${last ? ago(last.at) : 'never'} · next ${job.enabled ? when(job.next_at) : 'switched off'}</div>
    ${job.goal ? `<div class="meta">${esc(job.goal)}</div>` : ''}
    ${job.problems.length ? `<ul class="problems">${job.problems.map((p) => `<li>${esc(p.message)}</li>`).join('')}</ul>` : ''}
    <div class="actions">
      <button class="btn primary" data-run="${esc(job.id)}">Run now</button>
      <button class="btn" data-history="${esc(job.name)}">History</button>
      <button class="btn quiet" data-toggle="${esc(job.id)}" data-enabled="${job.enabled}">${job.enabled ? 'Switch off' : 'Switch on'}</button>
    </div>
  </article>`
}

function renderApprovals () {
  const list = state.approvals
  el('view-approvals').innerHTML = list.length === 0
    ? `<p class="empty">Nothing is waiting for a decision.</p>`
    : `<div class="cards">${list.map((a) => `<article class="card">
        <h3>${esc(a.job_name || a.job_id)}</h3>
        <div class="meta">asked ${ago(a.requested_at)}</div>
        <p>${esc(a.question || 'May it run?')}</p>
        <div class="actions">
          <button class="btn primary" data-approve="${esc(a.id)}">Approve and run</button>
          <button class="btn" data-reject="${esc(a.id)}">Reject</button>
        </div></article>`).join('')}</div>`
  el('view-approvals').querySelectorAll('[data-approve]').forEach((btn) => btn.addEventListener('click', async () => {
    btn.disabled = true
    try { const out = await api(`/api/approvals/${btn.dataset.approve}/approve`, { method: 'POST', body: {} }); await refresh(); if (out.run) showRun(out.run.id) } catch (err) { alert(err.message) }
  }))
  el('view-approvals').querySelectorAll('[data-reject]').forEach((btn) => btn.addEventListener('click', async () => {
    const note = prompt('Why not?') || ''
    try { await api(`/api/approvals/${btn.dataset.reject}/reject`, { method: 'POST', body: { note } }); refresh() } catch (err) { alert(err.message) }
  }))
}

async function renderRuns () {
  const runs = runFilter
    ? await api(`/api/runs?job=${encodeURIComponent(runFilter)}&limit=100`)
    : state.runs
  el('view-runs').innerHTML = `
    ${runFilter ? `<p class="meta">history of <strong>${esc(runFilter)}</strong> · <button class="btn quiet" id="clear-filter">show all</button></p>` : ''}
    ${runs.length === 0 ? '<p class="empty">No runs yet.</p>' : `<table><thead><tr>
      <th>when</th><th>job</th><th>status</th><th>took</th><th>cost</th><th>summary</th></tr></thead><tbody>
      ${runs.map((r) => `<tr class="clickable" data-open="${esc(r.id)}">
        <td>${esc(when(r.queued_at))}</td>
        <td>${esc(r.job_name || '—')}</td>
        <td><span class="tag ${esc(r.status)}">${esc(r.status)}</span></td>
        <td>${r.started_at && r.ended_at ? Math.max(1, Math.round((r.ended_at - r.started_at) / 1000)) + 's' : '—'}</td>
        <td>${r.cost_usd ? money(r.cost_usd) : '—'}</td>
        <td>${esc((r.summary || '').slice(0, 80))}</td></tr>`).join('')}
      </tbody></table>`}`
  el('clear-filter')?.addEventListener('click', () => { runFilter = null; renderRuns() })
  el('view-runs').querySelectorAll('[data-open]').forEach((row) => row.addEventListener('click', () => showRun(row.dataset.open)))
}

async function showRun (id) {
  const run = await api(`/api/runs/${id}`)
  openSheet(`<h2>${esc(run.job_id ? (state.jobs.find((j) => j.id === run.job_id)?.name || 'run') : 'run')}</h2>
    <dl class="kv">
      <dt>status</dt><dd>${esc(run.status)}${run.exit_code === null ? '' : ' · exit ' + run.exit_code}</dd>
      <dt>queued</dt><dd>${esc(when(run.queued_at))}</dd>
      <dt>started</dt><dd>${esc(when(run.started_at))}</dd>
      <dt>ended</dt><dd>${esc(when(run.ended_at))}</dd>
      <dt>cost</dt><dd>${esc(money(run.cost_usd))}</dd>
      <dt>trigger</dt><dd>${esc(run.trigger)}</dd>
    </dl>
    ${run.stdout ? `<h3>output</h3><pre>${esc(run.stdout)}</pre>` : ''}
    ${run.stderr ? `<h3>errors</h3><pre>${esc(run.stderr)}</pre>` : ''}`)
}

function renderWorkers () {
  el('view-workers').innerHTML = state.workers.length === 0
    ? `<p class="empty">No workers yet. Add one with <code>shopfloor worker add</code>.</p>`
    : `<div class="cards">${state.workers.map((w) => `<article class="card">
        <div class="row"><h3>${esc(w.name)}</h3><span class="tag">${esc(w.adapter)}</span></div>
        <div class="meta">${esc(w.role || 'no role written down')}</div>
        <div class="meta">today ${esc(money(w.budget.spentWorker))}${w.max_usd_day ? ` of ${w.max_usd_day} USD` : ' · no own cap'}</div>
        <pre>${esc(JSON.stringify(w.config, null, 2))}</pre>
      </article>`).join('')}
      <article class="card"><h3>Events</h3>
      <table><tbody>${state.events.slice(0, 15).map((e) => `<tr><td>${esc(ago(e.at))}</td><td>${esc(e.kind)}</td><td>${esc((e.message || '').slice(0, 90))}</td></tr>`).join('')}</tbody></table>
      </article></div>`
}

async function loadDigest () {
  el('view-digest').innerHTML = '<p class="empty">writing…</p>'
  const { text } = await api('/api/digest')
  el('view-digest').innerHTML = `<pre>${esc(text)}</pre>`
}

refresh()
setInterval(refresh, 5000)
