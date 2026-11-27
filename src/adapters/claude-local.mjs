import { runCommand, looksLikeQuotaProblem } from './spawn.mjs'
import { promptWithContext } from '../memory.mjs'

// Claude Code on this machine, in headless mode. It signs in the way the CLI
// already does, with the subscription or with CLAUDE_CODE_OAUTH_TOKEN, so no
// API key is needed and nothing is billed per token on top of the plan.
//
// Permissions. A headless run has nobody to click an allow button, so a job
// that writes files or runs commands needs either allowTools or, knowing what
// it means, skipPermissions. The gate that protects you is the approval step
// in front of the job, not a prompt inside the CLI.
export default {
  name: 'claude_local',
  describe: 'Runs a prompt through the local Claude Code CLI and reads back the cost it reports.',
  configFields: ['cli', 'model', 'cwd', 'systemPrompt', 'allowTools', 'disallowTools', 'tools', 'restricted',
    'strictMcp', 'permissionMode', 'maxBudgetUsd', 'skipPermissions', 'addDirs', 'env'],
  async run ({ worker, job, payload, timeoutSec, signal }) {
    const cfg = worker.config || {}
    const prompt = payload.prompt || cfg.prompt
    if (!prompt) throw new Error(`job ${job?.name} has no prompt`)

    const args = ['-p', promptWithContext(payload, prompt), '--output-format', 'json']
    const model = payload.model || cfg.model
    if (model) args.push('--model', model)
    const systemPrompt = payload.systemPrompt || cfg.systemPrompt
    if (systemPrompt) args.push('--append-system-prompt', systemPrompt)
    const allowTools = payload.allowTools || cfg.allowTools
    if (Array.isArray(allowTools) && allowTools.length) args.push('--allowedTools', allowTools.join(','))
    for (const dir of payload.addDirs || cfg.addDirs || []) args.push('--add-dir', dir)
    // The narrowing flags. A role sets all of them, because the user settings
    // on the machine may run in a bypass mode that a headless run would inherit.
    const tools = payload.tools ?? cfg.tools
    if (Array.isArray(tools)) args.push('--tools', tools.join(','))
    const disallowTools = payload.disallowTools || cfg.disallowTools
    if (Array.isArray(disallowTools) && disallowTools.length) args.push('--disallowedTools', disallowTools.join(','))
    if (payload.restricted ?? cfg.restricted) args.push('--restricted')
    if (payload.strictMcp ?? cfg.strictMcp) args.push('--strict-mcp-config')
    const permissionMode = payload.permissionMode || cfg.permissionMode
    if (permissionMode) args.push('--permission-mode', permissionMode)
    const maxBudget = payload.maxBudgetUsd ?? cfg.maxBudgetUsd
    if (maxBudget) args.push('--max-budget-usd', String(maxBudget))
    if (payload.skipPermissions ?? cfg.skipPermissions) args.push('--dangerously-skip-permissions')

    const result = await runCommand({
      command: payload.cli || cfg.cli || 'claude',
      args,
      cwd: payload.cwd || cfg.cwd || process.cwd(),
      env: { ...(cfg.env || {}), ...(payload.env || {}), SHOPFLOOR_JOB: job?.name || '' },
      timeoutSec,
      signal,
    })

    const parsed = readJson(result.stdout)
    const quota = looksLikeQuotaProblem(result.stderr) || looksLikeQuotaProblem(parsed?.result || '')
    return {
      exitCode: result.exitCode,
      stdout: parsed ? (parsed.result ?? result.stdout) : result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      aborted: result.aborted,
      costUsd: Number(parsed?.total_cost_usd ?? 0) || 0,
      summary: firstLine(parsed?.result ?? result.stdout),
      quotaProblem: quota,
      meta: parsed ? { numTurns: parsed.num_turns, durationMs: parsed.duration_ms, sessionId: parsed.session_id } : null,
      error: result.error,
    }
  },
}

function readJson (text = '') {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    const value = JSON.parse(trimmed)
    return Array.isArray(value) ? value.at(-1) : value
  } catch { return null }
}

function firstLine (text = '') {
  return String(text).trim().split('\n').find((l) => l.trim())?.slice(0, 400) || ''
}
