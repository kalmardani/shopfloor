# Shopfloor, developer notes

Everything here is plain ES modules on Node 22.5 or newer, with no dependency, no build step and no transpiler. The file the browser loads is the file in the repository. Keep it that way, because the whole promise of the project is that one person can read all of it in an afternoon.

## Map

```
bin/shopfloor.mjs      the whole command line, argument parsing included
src/config.mjs         SHOPFLOOR_HOME, config.json, defaults
src/db.mjs             node:sqlite schema and every query in the project
src/schedule.mjs       the schedule grammar, next firing time, silence windows
src/runner.mjs         one run start to finish, budget and approval gates
src/scheduler.mjs      the tick loop and the long running serve mode
src/health.mjs         the question of what went quiet
src/digest.mjs         the morning text and the notify hand off
src/server.mjs         http api and static files
src/ui/                index.html, style.css, app.js
src/adapters/          process, claude_local, codex_local, http, plus spawn.mjs
test/                  node:test, no network needed
```

Data lives in `~/.shopfloor/shopfloor.db`, a single SQLite file in WAL mode, with `config.json` beside it. `SHOPFLOOR_HOME` moves both, which is also how the tests stay out of your real shop.

## The shape of the thing

A **worker** is capability plus money. Name, adapter, adapter config, optional day cap.

A **job** is a worker on a schedule with a goal. It carries its own timeout, its approval flag, its silence window and a heartbeat secret.

A **run** is one attempt. It is created before the work starts, so a crash still leaves a record. Status moves `queued` to `running` to one of `ok`, `fail`, `timeout`, `quota`, `cancelled`, and the gates add `awaiting_approval`, `blocked`, `rejected`. A run left in `running` by a killed scheduler is closed as `lost` at the next start, which is what `markStaleRunsLost` is for.

An **approval** hangs off a run. The scheduler picks up approved work on the next tick, so approving from the interface, from the api or from the command line all behave the same.

An **event** is the audit trail. Runs, gates, scheduler starts and stops, digests.

A **heartbeat** is the dead man's switch for work that does not run here at all. `GET /hb/<token>` writes a timestamp, and the silence check treats a missing ping like a missing run.

## Where the money comes from

Only `claude_local` reports cost. It runs `claude -p <prompt> --output-format json` and reads `total_cost_usd` out of the answer. Codex prints nothing usable, so those runs count as zero, and the README says so rather than pretending. Ceilings are checked before a run starts, in `budgetState`, against the sum of today's `cost_usd`. A process worker is never blocked by the dollar ceiling, because its runs cost nothing.

Quota is read from text, in `looksLikeQuotaProblem`, because agent CLIs answer a hit limit in words rather than in exit codes. A `quota` run is not a failure of the job, so the next slot is pushed out by `retryAfterQuotaSec` and the silence window stays intact.

## Adding an adapter

Write a module in `src/adapters/` that exports a default object with `name`, `describe`, `configFields` and an async `run({ worker, job, payload, timeoutSec, signal })`. Return `{ exitCode, stdout, stderr, costUsd, summary, timedOut, aborted, quotaProblem, error }`. Register it in `src/adapters/index.mjs`. Spawn through `runCommand` from `spawn.mjs` so the timeout, the kill escalation and the output cap stay in one place. The run status is decided in `runner.mjs`, not in the adapter.

## Adding an api route

Routes are a flat switch in `src/server.mjs`, read as `/api/<section>/<id>/<action>`. Answer with `send(res, status, payload)`. Keep run output out of list answers through `stripOutput`, because a board that drags megabytes of stdout stops being pleasant. Static files are served only from `src/ui`, and the resolved path is checked against that directory.

## Traps worth knowing

**The tick is not a cron daemon.** Jobs carry `next_at` in the database, and the tick only looks for what is due. Changing a schedule recomputes `next_at` through `updateJob`, and switching a job off sets it to null. Restarting `serve` refills a null `next_at` for enabled jobs, so a long stop does not leave jobs dead.

**Intervals count from the last run.** `nextRun('every 15m', now, lastRunAt)` keeps the rhythm of the work instead of the rhythm of the restart, and a long overdue job is never scheduled into the past.

**One job never overlaps itself.** If the previous run is still `running`, the tick skips the slot and moves on. Parallelism is across jobs, capped by `maxConcurrentRuns`.

**Silence windows are generous on purpose.** Two missed slots plus a grace minute, at least an hour. A tighter window turns the digest into noise, and a digest that cries wolf is worse than no digest.

**The digest fires once a day from inside the tick.** The guard is a module level `lastDigestDay`, which means a fresh process on the same day can write a second one. `resetDigestMemory` exists for tests.

**SQLite is synchronous here.** `node:sqlite` is a blocking API, which is right for this scale and wrong for thousands of jobs. If the shop ever grows that far, the queries are all in one file.

## Tests

`node --test`. The schedule tests are pure. The lifecycle and http tests each create a temporary `SHOPFLOOR_HOME`, so they never touch a real shop, and they set the environment variable before the dynamic imports, because `config.mjs` reads it at import time. Nothing needs the network, and nothing calls an agent CLI.

## Style

British or American spelling, pick one per file and stay with it. No em dash anywhere, in code comments or in prose. Comments explain why a decision was made, not what the next line does. Keep user facing text in plain words, because the person reading `shopfloor doctor` at 7am is not in the mood for jargon.
