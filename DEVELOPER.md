# Shopfloor, developer notes

Everything here is plain ES modules on Node 22.5 or newer, with no dependency, no build step and no transpiler. The file the browser loads is the file in the repository. Keep it that way, because the whole promise of the project is that one person can read all of it in an afternoon.

## Map

```
bin/shopfloor.mjs      the whole command line, argument parsing included
src/config.mjs         SHOPFLOOR_HOME, config.json, defaults
src/db.mjs             node:sqlite schema and every query in the project
src/schedule.mjs       the schedule grammar, next firing time, silence windows
src/runner.mjs         one run start to finish, budget and approval gates
src/directives.mjs     what a run can say back through its own output
src/memory.mjs         what a job knows, and what goes in front of a prompt
src/outbox.mjs         the outgoing queue, its pacing and its gate, and the draft carrier
src/role.mjs           a job ad read into a spec, the agent settings it implies, screening
src/review.mjs         the weekly review of a role, sent after the digest
src/sources/google.mjs Search Console and GA4, read only, over fetch, and the data block
src/sources/google-consent.mjs   the one time sign in that writes a refresh token
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

A **job** is a worker on a schedule with a goal. It carries its own timeout, its approval flag, its silence window, a heartbeat secret and an inbox secret.

A **run** is one attempt. It is created before the work starts, so a crash still leaves a record. Status moves `queued` to `running` to one of `ok`, `fail`, `timeout`, `quota`, `cancelled`, and the gates add `awaiting_approval`, `blocked`, `rejected`. A run left in `running` by a killed scheduler is closed as `lost` at the next start, which is what `markStaleRunsLost` is for.

An **approval** hangs off a run. The scheduler picks up approved work on the next tick, so approving from the interface, from the api or from the command line all behave the same. An approval carries a `kind`, either `run` for work that has not started or `outbox` for finished work that wants to leave.

An **inbox event** is a reason for a run. Four sources write one, `message` from the command line, `webhook` from `POST /in/<token>`, `timer` from the tick, and `reply` from an earlier run. The row holds a payload, a dedupe key and a status, `pending` to `claimed` to `done` or `dropped`. Work that is parked rather than finished carries `wait_until`, which is how a day ceiling or a hit quota postpones an arrival instead of dropping it.

A **memory entry** is one key under one job, with the value, the kind (`note` or `pointer`), and the run that wrote it. It outlives every run, which is the point of keeping it outside the agent.

An **outbox entry** is finished work waiting to leave. Channel, recipient, subject, body, and a status of `pending`, `held` or `sent`. Nothing moves until `outboxSend` is on and an `outboxCommand` is there to carry it.

A **role** hangs off a job, one per job. It keeps the job ad as written next to the spec read from it, with a version that goes up on every `role set`. A role snapshot is what the data sources answered for one run, and the weekly review reads the newest one that had data.

A **log event** is the audit trail. Runs, gates, arrivals, memory writes, deliveries, scheduler starts and stops, digests.

A **heartbeat** is the dead man's switch for work that does not run here at all. `GET /hb/<token>` writes a timestamp, and the silence check treats a missing ping like a missing run.

## Where the money comes from

Only `claude_local` reports cost. It runs `claude -p <prompt> --output-format json` and reads `total_cost_usd` out of the answer. Codex prints nothing usable, so those runs count as zero, and the README says so rather than pretending. Ceilings are checked before a run starts, in `budgetState`, against the sum of today's `cost_usd`. A process worker is never blocked by the dollar ceiling, because its runs cost nothing.

Quota is read from text, in `looksLikeQuotaProblem`, because agent CLIs answer a hit limit in words rather than in exit codes. A `quota` run is not a failure of the job, so the next slot is pushed out by `retryAfterQuotaSec` and the silence window stays intact.

## Adding an adapter

Write a module in `src/adapters/` that exports a default object with `name`, `describe`, `configFields` and an async `run({ worker, job, payload, timeoutSec, signal })`. The payload the runner hands over is the job payload, plus `memory` as a rendered text block and `event` as the arrival itself. The arrival is never merged into the payload, so an event can describe work but cannot set `command`, `prompt`, `model` or anything else that decides what runs. A prompt adapter puts both in front of the prompt through `promptWithContext`, and `process` passes them down as `SHOPFLOOR_MEMORY`, `SHOPFLOOR_EVENT` and `SHOPFLOOR_EVENT_SOURCE`. Return `{ exitCode, stdout, stderr, costUsd, summary, timedOut, aborted, quotaProblem, error }`. Register it in `src/adapters/index.mjs`. Spawn through `runCommand` from `spawn.mjs` so the timeout, the kill escalation and the output cap stay in one place. The run status is decided in `runner.mjs`, not in the adapter.

## Adding a data source to roles

A source is a tool name in `TOOLS` in `src/role.mjs` with `gathered: true`, and a branch in `gatherForRole` in `src/sources/`. It gets the role spec and an injected `fetchImpl`, returns plain numbers, and lets every error message go through `redact` with the secrets it used. Metrics that the review should know go into `movement` and `METRIC_LABELS`, and a new goal metric into `GOAL_METRICS`. Keep the gathering in Shopfloor and out of the agent, because a credential the agent never sees is one it cannot leak.

## Adding an api route

Routes are a flat switch in `src/server.mjs`, read as `/api/<section>/<id>/<action>`. The sections are `state`, `workers`, `jobs`, `runs`, `approvals`, `inbox`, `memory`, `outbox`, `roles`, `events`, `digest`, `health`, `schedule` and `config`. Roles are read only over the api, because a job ad is a file someone writes. Two routes live outside the api and carry their own secret, `GET /hb/<token>` for the dead man's switch and `POST /in/<token>` for the webhook door. Answer with `send(res, status, payload)`. Keep run output out of list answers through `stripOutput`, because a board that drags megabytes of stdout stops being pleasant. Static files are served only from `src/ui`, and the resolved path is checked against that directory.

## Traps worth knowing

**One inbox, one worker.** `claimInboxEvent` refuses while an earlier event of the same job is still `claimed`, and the tick also skips a job whose previous run is going. Parallelism stays across jobs, never inside one inbox, because two runs answering the same arrival is the one failure an inbox is supposed to prevent.

**The dedupe key is a unique index, not a check in the code.** `inbox(job_id, dedupe_key)` is unique, so two schedulers racing on the same slot cannot both win. The timer writes its own firing with `timer:<slot>` as the key, which makes the inbox a complete ledger of why runs happened and stops a double fire. A duplicate slot advances `next_at` and skips, rather than leaving the job due for ever.

**An event driven run leaves the timer alone.** `executeRun` only moves `next_at` for a run with no inbox event behind it, or for a timer event. A webhook at noon therefore does not push a `daily 07:00` job to tomorrow noon.

**An event in front of a gate stays claimed.** A job with `requires_approval` creates the run and keeps the arrival in hand, so the next tick does not start the same work again. The approved run settles the event when it finishes, which `inboxEventForRun` finds without the caller passing anything.

**A self reply is a loop.** `::reply self` writes a new arrival with a new key, so a prompt that always says it will spin on every tick. The brakes are the ones that were already here, the day ceiling, the concurrency limit and the silence window, which is enough to notice it but not to stop it. A prompt that replies to itself should say when it stops.

**A killed scheduler leaves claims behind.** `releaseClaimedInboxEvents` hands them back on the next start, except where the run is still waiting for a person. It sits next to `markStaleRunsLost` for the same reason.

**Only a run that ended well is believed.** Directives are read from stdout, and `applyRunDirectives` is called for an `ok` run only, because half of a crashed answer is not an instruction. A directive is read at the start of a line, never inside a sentence, so prose about `::memory` is prose.

**Memory is capped on the way in.** `memoryValueChars` cuts a value at 2000 characters and the write is logged, because a run that pastes a whole file into memory is the poisoning this store has to survive. The rule for a prompt writer is simpler. Store what a run cannot look up again, and store a pointer to everything else.

**The shop floor starts quiet.** `outboxSend` is false by default, so an entry waits in the queue and a missing delivery command cannot be mistaken for silence. Turning sending on is one decision, approving one entry is another, and both are needed before anything leaves the machine.

**A failed delivery holds the entry and drops the decision.** The approval link is cleared, so nothing retries by itself at every tick. `shopfloor outbox retry` puts the entry back in the queue once the carrier works again.

**An outbox approval never starts a run.** The run behind the entry finished long ago, so `runApproved` refuses an approval whose kind is not `run`, and the command line and the api send the entry instead. Pacing is measured from the last delivery and not from the start of the pass, because a delivery inside the loop has already moved the clock.

**CREATE TABLE IF NOT EXISTS adds no columns.** An older database keeps the shape it had, which is what the `MIGRATIONS` list in `db.mjs` is for. One line per column, added on open, and a backfill for the inbox token of jobs that were made before there was one.

**The tick is not a cron daemon.** Jobs carry `next_at` in the database, and the tick only looks for what is due. Changing a schedule recomputes `next_at` through `updateJob`, and switching a job off sets it to null. Restarting `serve` refills a null `next_at` for enabled jobs, so a long stop does not leave jobs dead.

**Intervals count from the last run.** `nextRun('every 15m', now, lastRunAt)` keeps the rhythm of the work instead of the rhythm of the restart, and a long overdue job is never scheduled into the past.

**One job never overlaps itself.** If the previous run is still `running`, the tick skips the slot and moves on. Parallelism is across jobs, capped by `maxConcurrentRuns`.

**Silence windows are generous on purpose.** Two missed slots plus a grace minute, at least an hour. A tighter window turns the digest into noise, and a digest that cries wolf is worse than no digest.

**The digest fires once a day from inside the tick.** The guard is a module level `lastDigestDay`, which means a fresh process on the same day can write a second one. `resetDigestMemory` exists for tests.

**A role is enforced twice, at hire and at every run.** `hireRole` writes the narrowing flags into the worker config, and `prepareRoleRun` puts them in the payload again, where they win over the worker config. Editing the worker by hand therefore cannot widen a role, which a test checks by setting `skipPermissions` on the worker and watching it disappear from the command line.

**The machine's own Claude settings are not on your side.** A user settings file in `bypassPermissions` mode with `Bash(npx *)` allowed is common on a developer's laptop, and a headless run inherits it. That is why a role passes `--restricted`, `--tools`, `--disallowedTools`, `--strict-mcp-config` and `--permission-mode dontAsk` together. Deny rules win over a bypass mode, and `--tools` removes the tool from the session altogether.

**An event is data, never configuration.** Anyone who holds an inbox token can post to `/in/<token>`, so the arrival reaches the work only as `payload.event` and is never spread over the job payload. A role goes one step further and clears everything except `memory` and `event` before its own settings go in, so even the job payload cannot widen it.

**A draft asks the gate when it is queued.** Outbox approvals are normally created by `dispatchOutbox`, which never runs while `outboxSend` is off. A draft would then never reach a person, so `screenRoleOutput` creates the approval itself, and `gateFor` asks for one on the draft channel even when `outboxRequiresApproval` is false.

**An approved draft is saved, not sent.** The `draft` channel has its own carrier in `outbox.mjs`, a file in `drafts_dir`, and it works while the shop floor is quiet, because nothing leaves the machine. The role check refuses a `drafts_dir` inside a `site` folder, since `wrangler pages deploy .` and its kind publish everything in the folder.

**The writing check fails closed.** A `style_check` command that cannot run holds the draft as if the text had failed, and the reason is stored under `held_back` in the job's memory, which the next shift reads in front of its prompt.

**The review guard is an event, not a variable.** `maybeSendReviews` looks for a `role:review` event of the job in the last six days, so a restarted scheduler does not send the same week twice. It only runs inside `maybeSendDigest`, so a shop without `digestAt` sends no review on its own, and `shopfloor role review <job> --notify` is the manual way.

**SQLite is synchronous here.** `node:sqlite` is a blocking API, which is right for this scale and wrong for thousands of jobs. If the shop ever grows that far, the queries are all in one file.

## Tests

`node --test`, sixty six of them. The schedule and directive tests are pure. The lifecycle, queue and http tests each create a temporary `SHOPFLOOR_HOME`, so they never touch a real shop, and they set the environment variable before the dynamic imports, because `config.mjs` reads it at import time. Nothing needs the network, and nothing calls an agent CLI. A delivery in a test is a shell command that appends to a file in the temporary home, which is the same path a real carrier takes. A role test writes a small `fake-claude` executable that records its arguments and answers in the CLI's JSON shape, and swaps the network for a stub with `setRoleFetch`, so the flags, the briefing and the screening are all checked without a model or Google.

## Style

British or American spelling, pick one per file and stay with it. No em dash anywhere, in code comments or in prose. Comments explain why a decision was made, not what the next line does. Keep user facing text in plain words, because the person reading `shopfloor doctor` at 7am is not in the mood for jargon.
