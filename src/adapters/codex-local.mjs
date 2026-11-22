import { runCommand, looksLikeQuotaProblem } from './spawn.mjs'

// Codex CLI on this machine. It reads the sign in the CLI already holds in
// ~/.codex/auth.json, so a ChatGPT plan is enough and no API key is needed.
// Codex prints no cost, so these runs count as zero and the budget ceiling
// only sees the Claude side.
export default {
  name: 'codex_local',
  describe: 'Runs a prompt through the local Codex CLI.',
  configFields: ['cli', 'cwd', 'sandbox', 'model', 'skipGitRepoCheck', 'env'],
  async run ({ worker, job, payload, timeoutSec, signal }) {
    const cfg = worker.config || {}
    const prompt = payload.prompt || cfg.prompt
    if (!prompt) throw new Error(`job ${job?.name} has no prompt`)

    const args = ['exec']
    if (payload.skipGitRepoCheck ?? cfg.skipGitRepoCheck ?? true) args.push('--skip-git-repo-check')
    const sandbox = payload.sandbox || cfg.sandbox || 'read-only'
    args.push('--sandbox', sandbox)
    const model = payload.model || cfg.model
    if (model) args.push('--model', model)
    args.push(prompt)

    const result = await runCommand({
      command: cfg.cli || 'codex',
      args,
      cwd: payload.cwd || cfg.cwd || process.cwd(),
      env: { ...(cfg.env || {}), ...(payload.env || {}), SHOPFLOOR_JOB: job?.name || '' },
      timeoutSec,
      signal,
    })

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      aborted: result.aborted,
      costUsd: 0,
      summary: (result.stdout || '').trim().split('\n').at(-1)?.slice(0, 400) || '',
      quotaProblem: looksLikeQuotaProblem(result.stderr),
      error: result.error,
    }
  },
}
