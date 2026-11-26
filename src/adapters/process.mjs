import { runCommand, looksLikeQuotaProblem } from './spawn.mjs'

// The adapter that keeps your own scripts yours. Anything that already runs
// from a terminal runs here, unchanged, and the shop floor only watches it.
export default {
  name: 'process',
  describe: 'Runs a shell command and keeps its output, exit code and duration.',
  configFields: ['command', 'cwd', 'env'],
  async run ({ worker, job, payload, timeoutSec, signal }) {
    const command = payload.command || worker.config.command
    if (!command) throw new Error(`worker ${worker.name} has no command`)
    const result = await runCommand({
      command,
      cwd: payload.cwd || worker.config.cwd || process.cwd(),
      env: {
        ...(worker.config.env || {}),
        ...(payload.env || {}),
        SHOPFLOOR_JOB: job?.name || '',
        // A script reads what the job knows and what woke it up from the
        // environment, which keeps the adapter free of any prompt idea.
        SHOPFLOOR_MEMORY: (payload.memory || '').slice(0, 8000),
        SHOPFLOOR_EVENT: payload.event ? JSON.stringify(payload.event).slice(0, 8000) : '',
        SHOPFLOOR_EVENT_SOURCE: payload.event?.source || '',
      },
      timeoutSec,
      signal,
    })
    const tail = (result.stdout || '').trim().split('\n').filter(Boolean).at(-1) || ''
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      aborted: result.aborted,
      costUsd: 0,
      summary: tail.slice(0, 400),
      quotaProblem: looksLikeQuotaProblem(result.stderr),
      error: result.error,
    }
  },
}
