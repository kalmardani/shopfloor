import processAdapter from './process.mjs'
import claudeLocal from './claude-local.mjs'
import codexLocal from './codex-local.mjs'
import httpAdapter from './http.mjs'

export const adapters = {
  process: processAdapter,
  claude_local: claudeLocal,
  codex_local: codexLocal,
  http: httpAdapter,
}

export function getAdapter (name) {
  const adapter = adapters[name]
  if (!adapter) throw new Error(`unknown adapter: ${name}. Known adapters: ${Object.keys(adapters).join(', ')}`)
  return adapter
}

export const adapterNames = Object.keys(adapters)
