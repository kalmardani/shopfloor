import { readFileSync, existsSync } from 'node:fs'
import { createSign } from 'node:crypto'

// Search Console and GA4, read only, over plain fetch. The shop floor gathers
// the numbers itself and hands the agent a finished table, so the agent never
// sees a credential and never needs a tool that could reach Google on its own.
//
// Two ways in. An OAuth refresh token from an env file, named by variable so
// the role file holds names and never values, or a service account key file.
// Either way the scope is read only for both products.

export const SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
]

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GSC_URL = (site) => `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`
const GA4_URL = (property) => `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(property)}:runReport`

// A KEY=value file, the way shells and dotenv write them. Values are returned
// to the caller and never logged here.
export function readEnvFile (path) {
  if (!path || !existsSync(path)) return {}
  const out = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!match) continue
    let value = match[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    out[match[1]] = value
  }
  return out
}

// Every message that leaves this module goes through here first, so a Google
// error that echoes a token back cannot carry it into the run log.
export function redact (text, secrets = []) {
  let out = String(text ?? '')
  for (const secret of secrets) {
    if (secret && String(secret).length >= 6) out = out.split(String(secret)).join('[hidden]')
  }
  return out
}

// What the role needs to reach Google, read from where the role says, with
// the reason spelled out when something is missing. Never the values.
export function loadCredentials (spec) {
  const c = spec.credentials
  if (!c) return { ok: false, reason: 'the role names no credentials' }
  if (c.type === 'service_account') {
    if (!c.keyFile || !existsSync(c.keyFile)) return { ok: false, reason: `the service account key file is not there (${c.keyFile})` }
    try {
      const key = JSON.parse(readFileSync(c.keyFile, 'utf8'))
      if (!key.client_email || !key.private_key) return { ok: false, reason: 'the service account key file has no client_email or private_key' }
      return { ok: true, type: 'service_account', clientEmail: key.client_email, privateKey: key.private_key, tokenUri: key.token_uri || TOKEN_URL, secrets: [key.private_key] }
    } catch { return { ok: false, reason: 'the service account key file is not valid JSON' } }
  }
  const env = { ...readEnvFile(spec.credentialsFile), ...pick(process.env, [c.clientIdVar, c.clientSecretVar, c.refreshTokenVar]) }
  const missing = [c.clientIdVar, c.clientSecretVar, c.refreshTokenVar].filter((name) => !env[name])
  if (missing.length) return { ok: false, reason: `missing in ${spec.credentialsFile || 'the environment'}: ${missing.join(', ')}` }
  const clientId = env[c.clientIdVar]
  const clientSecret = env[c.clientSecretVar]
  const refreshToken = env[c.refreshTokenVar]
  return { ok: true, type: 'oauth', clientId, clientSecret, refreshToken, secrets: [clientSecret, refreshToken] }
}

function pick (source, names) {
  const out = {}
  for (const name of names) if (name && source[name]) out[name] = source[name]
  return out
}

export async function accessToken (creds, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  let body
  if (creds.type === 'service_account') {
    const iat = Math.floor(now / 1000)
    const claim = { iss: creds.clientEmail, scope: SCOPES.join(' '), aud: creds.tokenUri, iat, exp: iat + 3600 }
    const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claim))}`
    const signature = createSign('RSA-SHA256').update(unsigned).sign(creds.privateKey)
    body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(signature)}` })
  } else {
    body = new URLSearchParams({ grant_type: 'refresh_token', client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: creds.refreshToken })
  }
  const res = await fetchImpl(creds.tokenUri || TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
  const text = await res.text()
  if (!res.ok) throw new Error(redact(`Google refused the sign in (${res.status}): ${text.slice(0, 300)}`, creds.secrets))
  const token = JSON.parse(text).access_token
  if (!token) throw new Error('Google answered the sign in without an access token')
  return token
}

function b64url (value) {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

async function postJson (url, payload, { token, fetchImpl, secrets }) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(redact(`${new URL(url).hostname} answered ${res.status}: ${text.slice(0, 300)}`, [...secrets, token]))
  return JSON.parse(text || '{}')
}

/* ---------- the two windows ---------- */

// Seven closed days that end a few days back, because Search Console needs
// time to settle, and the week before for comparison. Every source reads the
// same two windows, so the numbers can be put side by side.
export function reportWindows (at = Date.now(), { lagDays = 3, days = 7 } = {}) {
  const end = shiftDay(at, -lagDays)
  return {
    current: { start: dayString(shiftDay(end, -(days - 1))), end: dayString(end) },
    previous: { start: dayString(shiftDay(end, -(2 * days - 1))), end: dayString(shiftDay(end, -days)) },
  }
}

function shiftDay (ms, days) {
  const d = new Date(ms)
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() + days)
  return d.getTime()
}

export function dayString (ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/* ---------- Search Console ---------- */

async function gscQuery (site, window, dimensions, rowLimit, ctx) {
  const answer = await postJson(GSC_URL(site), { startDate: window.start, endDate: window.end, dimensions, rowLimit, dataState: 'final' }, ctx)
  return (answer.rows || []).map((row) => ({
    keys: row.keys || [],
    clicks: Number(row.clicks || 0),
    impressions: Number(row.impressions || 0),
    ctr: Number(row.ctr || 0),
    position: Number(row.position || 0),
  }))
}

function totals (rows) {
  const row = rows[0]
  return row
    ? { clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position }
    : { clicks: 0, impressions: 0, ctr: 0, position: 0 }
}

export async function gatherSearchConsole (site, windows, ctx) {
  const [cur, prev, queries, pages, prevPages, pairs] = await Promise.all([
    gscQuery(site, windows.current, [], 1, ctx),
    gscQuery(site, windows.previous, [], 1, ctx),
    gscQuery(site, windows.current, ['query'], 25, ctx),
    gscQuery(site, windows.current, ['page'], 100, ctx),
    gscQuery(site, windows.previous, ['page'], 100, ctx),
    gscQuery(site, windows.current, ['query', 'page'], 500, ctx),
  ])

  // A query that already shows up on page one or two but gets few clicks is
  // the cheapest win there is, so it is picked out here rather than left to
  // the agent to find in a long table.
  const strikingDistance = pairs
    .filter((r) => r.position >= 4 && r.position <= 20 && r.impressions >= 5)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 15)
    .map((r) => ({ query: r.keys[0], page: r.keys[1], position: round(r.position, 1), impressions: r.impressions, clicks: r.clicks }))

  const before = new Map(prevPages.map((r) => [r.keys[0], r]))
  const losers = pages
    .map((r) => ({ page: r.keys[0], clicks: r.clicks, prevClicks: before.get(r.keys[0])?.clicks ?? 0, impressions: r.impressions, prevImpressions: before.get(r.keys[0])?.impressions ?? 0 }))
    .concat(prevPages.filter((r) => !pages.some((p) => p.keys[0] === r.keys[0]))
      .map((r) => ({ page: r.keys[0], clicks: 0, prevClicks: r.clicks, impressions: 0, prevImpressions: r.impressions })))
    .map((r) => ({ ...r, delta: r.clicks - r.prevClicks }))
    .filter((r) => r.delta < 0)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, 10)

  return {
    current: totals(cur),
    previous: totals(prev),
    queries: queries.map((r) => ({ query: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: round(r.ctr * 100, 1), position: round(r.position, 1) })),
    pages: pages.slice(0, 25).map((r) => ({ page: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: round(r.position, 1) })),
    strikingDistance,
    losers,
  }
}

/* ---------- GA4 ---------- */

const ORGANIC = { filter: { fieldName: 'sessionDefaultChannelGroup', stringFilter: { value: 'Organic Search' } } }

async function ga4Report (property, body, ctx) {
  const answer = await postJson(GA4_URL(property), body, ctx)
  return (answer.rows || []).map((row) => ({
    dims: (row.dimensionValues || []).map((v) => v.value),
    values: (row.metricValues || []).map((v) => Number(v.value || 0)),
  }))
}

export async function gatherGa4 (property, windows, ctx) {
  const metrics = [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'screenPageViews' }]
  const range = (w) => [{ startDate: w.start, endDate: w.end }]
  const [all, prevAll, organic, prevOrganic, landing] = await Promise.all([
    ga4Report(property, { dateRanges: range(windows.current), metrics }, ctx),
    ga4Report(property, { dateRanges: range(windows.previous), metrics }, ctx),
    ga4Report(property, { dateRanges: range(windows.current), metrics: [{ name: 'sessions' }], dimensionFilter: ORGANIC }, ctx),
    ga4Report(property, { dateRanges: range(windows.previous), metrics: [{ name: 'sessions' }], dimensionFilter: ORGANIC }, ctx),
    ga4Report(property, {
      dateRanges: range(windows.current),
      dimensions: [{ name: 'landingPage' }],
      metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }],
      dimensionFilter: ORGANIC,
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 15,
    }, ctx),
  ])
  const sum = (rows) => ({ sessions: rows[0]?.values[0] ?? 0, activeUsers: rows[0]?.values[1] ?? 0, views: rows[0]?.values[2] ?? 0 })
  return {
    current: { ...sum(all), organicSessions: organic[0]?.values[0] ?? 0 },
    previous: { ...sum(prevAll), organicSessions: prevOrganic[0]?.values[0] ?? 0 },
    organicLanding: landing.map((r) => ({ page: r.dims[0], sessions: r.values[0], engaged: r.values[1] })),
  }
}

/* ---------- one gathering for one shift ---------- */

// Reads every source the role names. A source that fails is written down with
// the reason and the others still count, because half the picture is worth
// having as long as nobody mistakes it for the whole one.
export async function gatherForRole (spec, { fetchImpl = globalThis.fetch, at = Date.now() } = {}) {
  const windows = reportWindows(at)
  const snapshot = { at, windows, gsc: null, ga4: null, errors: [] }
  const wanted = spec.tools.filter((t) => t.name === 'search_console' || t.name === 'ga4')
  if (!wanted.length) return snapshot

  const creds = loadCredentials(spec)
  if (!creds.ok) {
    snapshot.errors.push({ source: 'credentials', message: creds.reason })
    return snapshot
  }
  let token
  try {
    token = await accessToken(creds, { fetchImpl, now: at })
  } catch (err) {
    snapshot.errors.push({ source: 'credentials', message: redact(err.message, creds.secrets) })
    return snapshot
  }
  const ctx = { token, fetchImpl, secrets: creds.secrets }

  await Promise.all(wanted.map(async (tool) => {
    try {
      if (tool.name === 'search_console') snapshot.gsc = await gatherSearchConsole(tool.target, windows, ctx)
      else snapshot.ga4 = await gatherGa4(tool.target, windows, ctx)
    } catch (err) {
      snapshot.errors.push({ source: tool.name, message: redact(err.message, [...creds.secrets, token]) })
    }
  }))
  return snapshot
}

/* ---------- reading a snapshot ---------- */

export function round (value, digits = 0) {
  const f = 10 ** digits
  return Math.round(Number(value || 0) * f) / f
}

export function change (current, previous) {
  const delta = Number(current || 0) - Number(previous || 0)
  const pct = previous ? (delta / previous) * 100 : null
  return { current: Number(current || 0), previous: Number(previous || 0), delta, pct }
}

// The headline numbers of one snapshot, every one with its change against the
// week before, computed here so no reader does arithmetic in their head.
export function movement (snapshot) {
  const out = {}
  if (snapshot?.gsc) {
    const { current: c, previous: p } = snapshot.gsc
    out['gsc.clicks'] = change(c.clicks, p.clicks)
    out['gsc.impressions'] = change(c.impressions, p.impressions)
    out['gsc.ctr'] = change(round(c.ctr * 100, 2), round(p.ctr * 100, 2))
    out['gsc.position'] = change(round(c.position, 1), round(p.position, 1))
  }
  if (snapshot?.ga4) {
    const { current: c, previous: p } = snapshot.ga4
    out['ga4.organicSessions'] = change(c.organicSessions, p.organicSessions)
    out['ga4.sessions'] = change(c.sessions, p.sessions)
    out['ga4.activeUsers'] = change(c.activeUsers, p.activeUsers)
  }
  return out
}

export const METRIC_LABELS = {
  'gsc.clicks': 'Search Console clicks',
  'gsc.impressions': 'Search Console impressions',
  'gsc.ctr': 'Search Console CTR (%)',
  'gsc.position': 'Search Console average position',
  'ga4.organicSessions': 'GA4 organic sessions',
  'ga4.sessions': 'GA4 sessions, all channels',
  'ga4.activeUsers': 'GA4 active users',
}

export function formatChange (m) {
  if (!m) return 'no data'
  const sign = m.delta > 0 ? '+' : ''
  const pct = m.pct === null ? '' : `, ${sign}${round(m.pct, 1)}%`
  return `${m.current} (week before ${m.previous}, ${sign}${round(m.delta, 2)}${pct})`
}

// The data block a shift starts with. Plain lines, so the agent reads tables
// it did not have to fetch and cannot misremember.
export function renderSnapshot (snapshot) {
  if (!snapshot) return 'No data was gathered for this shift.'
  const lines = []
  const w = snapshot.windows
  lines.push(`Window ${w.current.start} to ${w.current.end}, compared with ${w.previous.start} to ${w.previous.end}.`)
  for (const [key, m] of Object.entries(movement(snapshot))) lines.push(`- ${METRIC_LABELS[key]} ${formatChange(m)}`)
  const g = snapshot.gsc
  if (g) {
    if (g.strikingDistance.length) {
      lines.push('', 'Queries on positions 4 to 20, most impressions first (query | page | position | impressions | clicks)')
      for (const r of g.strikingDistance) lines.push(`- ${r.query} | ${r.page} | ${r.position} | ${r.impressions} | ${r.clicks}`)
    }
    if (g.losers.length) {
      lines.push('', 'Pages that lost clicks against the week before (page | clicks | before | change)')
      for (const r of g.losers) lines.push(`- ${r.page} | ${r.clicks} | ${r.prevClicks} | ${r.delta}`)
    }
    if (g.queries.length) {
      lines.push('', 'Top queries (query | clicks | impressions | CTR % | position)')
      for (const r of g.queries.slice(0, 15)) lines.push(`- ${r.query} | ${r.clicks} | ${r.impressions} | ${r.ctr} | ${r.position}`)
    }
  }
  if (snapshot.ga4?.organicLanding?.length) {
    lines.push('', 'Organic landing pages in GA4 (page | sessions | engaged sessions)')
    for (const r of snapshot.ga4.organicLanding) lines.push(`- ${r.page} | ${r.sessions} | ${r.engaged}`)
  }
  for (const e of snapshot.errors) lines.push('', `Not available, ${e.source}. ${e.message}`)
  return lines.join('\n')
}
