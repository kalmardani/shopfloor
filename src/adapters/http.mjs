// A webhook worker, for the part of the shop that lives on another machine.
export default {
  name: 'http',
  describe: 'Posts the payload to a URL and judges the run by the response status.',
  configFields: ['url', 'method', 'headers'],
  async run ({ worker, job, payload, timeoutSec, signal }) {
    const cfg = worker.config || {}
    const url = payload.url || cfg.url
    if (!url) throw new Error(`worker ${worker.name} has no url`)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutSec * 1000)
    signal?.addEventListener('abort', () => controller.abort(), { once: true })
    try {
      const res = await fetch(url, {
        method: payload.method || cfg.method || 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.headers || {}), ...(payload.headers || {}) },
        body: JSON.stringify({ job: job?.name, ...payload.body }),
        signal: controller.signal,
      })
      const text = (await res.text()).slice(0, 20000)
      return {
        exitCode: res.ok ? 0 : 1,
        stdout: text,
        stderr: res.ok ? '' : `HTTP ${res.status} ${res.statusText}`,
        costUsd: 0,
        summary: `HTTP ${res.status}`,
        quotaProblem: res.status === 429,
        error: null,
      }
    } catch (err) {
      return { exitCode: null, stdout: '', stderr: String(err.message), costUsd: 0, summary: 'request failed', quotaProblem: false, error: err.message }
    } finally {
      clearTimeout(timer)
    }
  },
}
