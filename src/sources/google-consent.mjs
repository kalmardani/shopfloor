import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync, copyFileSync, chmodSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { SCOPES, readEnvFile, redact } from './google.mjs'

// One sign in, done by the person who owns the Google account, in their own
// browser. The shop floor listens on 127.0.0.1 for the answer, trades the code
// for a refresh token, and writes it into the env file under the name the
// role gives. Nothing is printed, because the terminal is not a safe place
// for a key that reads a whole Search Console account.

// Replaces one KEY=value line, or adds it, and leaves every other line as it
// was. A copy of the old file is kept beside it.
export function setEnvValue (path, name, value) {
  const before = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (before) copyFileSync(path, `${path}.bak-${new Date().toISOString().slice(0, 10)}`)
  const lines = before ? before.split(/\r?\n/) : []
  const at = lines.findIndex((l) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(l))
  if (at >= 0) lines[at] = `${name}=${value}`
  else {
    if (lines.length && lines.at(-1) === '') lines.pop()
    lines.push(`${name}=${value}`, '')
  }
  writeFileSync(path, lines.join('\n'), { mode: 0o600 })
  // A file of keys is for its owner only, whatever mode it had before.
  chmodSync(path, 0o600)
}

export async function exchangeCode ({ code, clientId, clientSecret, redirectUri, fetchImpl = globalThis.fetch }) {
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(redact(`Google refused the code (${res.status}): ${text.slice(0, 300)}`, [clientSecret, code]))
  const answer = JSON.parse(text)
  if (!answer.refresh_token) throw new Error('Google sent no refresh token. Remove the earlier grant at myaccount.google.com/permissions and try again.')
  return answer.refresh_token
}

export function connectGoogle (spec, { log = console.log, timeoutSec = 300 } = {}) {
  const c = spec.credentials
  if (c?.type !== 'oauth') throw new Error('connect is for oauth credentials, a service account needs no sign in')
  const env = readEnvFile(spec.credentialsFile)
  const clientId = env[c.clientIdVar]
  const clientSecret = env[c.clientSecretVar]
  if (!clientId || !clientSecret) throw new Error(`${c.clientIdVar} and ${c.clientSecretVar} must be in ${spec.credentialsFile} first`)

  return new Promise((resolve, reject) => {
    const state = randomBytes(16).toString('hex')
    let redirectUri = null
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.pathname !== '/') { res.writeHead(404).end(); return }
      if (url.searchParams.get('state') !== state) { res.writeHead(400).end('state does not match'); return }
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      try {
        if (error || !code) throw new Error(`Google answered ${error || 'without a code'}`)
        const token = await exchangeCode({ code, clientId, clientSecret, redirectUri })
        setEnvValue(spec.credentialsFile, c.refreshTokenVar, token)
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('Shopfloor has the read only access now. This tab can be closed.')
        finish(null, `${c.refreshTokenVar} saved in ${spec.credentialsFile}`)
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('The sign in did not work, the terminal says why.')
        finish(err)
      }
    })
    const timer = setTimeout(() => finish(new Error(`no answer from the browser in ${timeoutSec}s`)), timeoutSec * 1000)
    function finish (err, message) {
      clearTimeout(timer)
      server.close()
      if (err) reject(err); else resolve(message)
    }
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${server.address().port}/`
      const consent = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      consent.search = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '),
        access_type: 'offline', prompt: 'consent', state,
      }).toString()
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
      const child = spawn(opener, [consent.toString()], { stdio: 'ignore', detached: true })
      child.on('error', () => finish(new Error(`could not open a browser with ${opener}`)))
      child.unref()
      log('A browser tab opened with the Google consent page. Sign in with the account that owns Search Console and GA4.')
      log(`Waiting up to ${timeoutSec}s for the answer on 127.0.0.1.`)
    })
  })
}
