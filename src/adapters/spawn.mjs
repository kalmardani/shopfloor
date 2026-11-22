import { spawn } from 'node:child_process'

// One place where a child process is started, watched, limited in size and
// killed on time. Every adapter that runs a command goes through here.
export function runCommand ({ command, args = null, cwd = process.cwd(), env = {}, timeoutSec = 900,
  input = null, maxChars = 200000, signal = null }) {
  return new Promise((resolve) => {
    const useShell = args === null
    const child = useShell
      ? spawn(process.env.SHELL || '/bin/sh', ['-lc', command], { cwd, env: { ...process.env, ...env } })
      : spawn(command, args, { cwd, env: { ...process.env, ...env } })

    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let killedBySignal = false

    const take = (chunk, which) => {
      const text = chunk.toString()
      if (which === 'out') {
        if (stdout.length + text.length > maxChars) { truncated = true; stdout = (stdout + text).slice(-maxChars) }
        else stdout += text
      } else {
        if (stderr.length + text.length > maxChars) { truncated = true; stderr = (stderr + text).slice(-maxChars) }
        else stderr += text
      }
    }

    child.stdout.on('data', (c) => take(c, 'out'))
    child.stderr.on('data', (c) => take(c, 'err'))

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000).unref?.()
    }, timeoutSec * 1000)

    const onAbort = () => {
      killedBySignal = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000).unref?.()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    if (input !== null) {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    } else {
      child.stdin.end()
    }

    child.on('error', (err) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ exitCode: null, stdout, stderr: stderr + String(err.message), timedOut, truncated, error: err.message })
    })

    child.on('close', (code, sig) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({
        exitCode: code,
        signal: sig,
        stdout,
        stderr,
        timedOut,
        aborted: killedBySignal,
        truncated,
        error: null,
      })
    })
  })
}

// Agent CLIs answer a hit quota in words, not in exit codes, so the text is
// where the answer lives.
const QUOTA_PATTERNS = [
  /usage limit reached/i,
  /rate[_ -]?limit/i,
  /quota (?:exceeded|exhausted)/i,
  /429/,
  /resets? at/i,
  /credit balance is too low/i,
]

export function looksLikeQuotaProblem (text = '') {
  return QUOTA_PATTERNS.some((p) => p.test(text))
}
