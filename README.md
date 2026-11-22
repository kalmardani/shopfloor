# Shopfloor

A shop floor for the AI agents you already run. It schedules them, keeps the run log, counts the money, holds the risky work behind a human decision, and tells you which job went quiet.

Zero dependencies. One SQLite file. Node 22.5 or newer and nothing else.

```
npx github:kalmardani/shopfloor init
npx github:kalmardani/shopfloor serve
```

![The board, with one job that went quiet and one waiting for a decision](docs/board.png)

## Why it exists

Agent CLIs are good at work and bad at running a shop. A prompt in `cron` fires into the dark. A `launchd` plist that never loaded looks exactly like a plist that runs fine. A subscription burns through its quota at 2am and the morning looks normal. The failure nobody sees is the expensive one, and the agent frameworks that wrap the model do not solve it, because the gap is in the floor above them.

Shopfloor is that floor. Your scripts and prompts stay yours, unchanged. Shopfloor only decides when they run, writes down what happened, stops them at a dollar ceiling, asks before anything leaves the building, and raises a hand when a job stops reporting.

The whole thing fits in a single file database and a web interface you can read in one sitting, because a supervisor you cannot read is one more thing to supervise.

## Install

```bash
git clone https://github.com/kalmardani/shopfloor.git
cd shopfloor
node bin/shopfloor.mjs init
```

There is nothing to compile and nothing to download. `npm install` is not needed, because the package has no dependencies.

Optionally put it on your path.

```bash
npm link                 # gives you the shopfloor command
shopfloor --help
```

Everything lives in `~/.shopfloor` (`shopfloor.db` and `config.json`). Point `SHOPFLOOR_HOME` somewhere else if you want more than one shop.

## Five minutes from here

A shell script you already have, watched from now on.

```bash
shopfloor worker add nightly --adapter process \
  --command "node ~/Developer/my-thing/run.mjs" --cwd ~/Developer/my-thing
shopfloor job add nightly-build --worker nightly --schedule "daily 02:30" \
  --goal "build the report so it is ready before breakfast"
shopfloor serve
```

A prompt through the Claude Code CLI on this machine, on your plan, with a daily ceiling.

```bash
shopfloor worker add researcher --adapter claude_local \
  --model claude-opus-5 --cwd ~/Developer/notes --cap 2 \
  --allow-tools "Read,Grep,WebSearch"
shopfloor job add morning-scan --worker researcher --schedule "weekdays 07:00" \
  --prompt "Read today's notes and write three lines about what changed."
```

Work that must never go out on its own.

```bash
shopfloor job add weekly-letter --worker researcher --schedule "fri 16:00" --approval \
  --prompt "Draft the weekly client letter from this week's notes."
shopfloor approvals
shopfloor approve 1a2b3c4d
```

Something that runs outside Shopfloor and should be missed when it dies.

```bash
shopfloor job add tender-crawler --worker nightly --schedule "every 6h"
shopfloor heartbeat tender-crawler
# put the printed curl line at the end of the launchd script
```

And every morning, in one text.

```bash
shopfloor digest
shopfloor doctor
```

## What it gives you

**Jobs and workers.** A worker is how work gets done (a command, a prompt, a webhook) with its own ceiling. A job is a worker on a schedule with a goal written down. Both are rows in one SQLite file you can read with any tool.

**Schedules in words.** `every 15m`, `daily 07:30`, `weekdays 08:00`, `mon 09:00`, `monthly 1 09:00`, `manual`, and five field cron when you want it. A schedule nobody can read is refused when you type it, not at 3am.

**A run log that keeps the output.** Status, exit code, duration, cost, the tail of stdout and stderr. Status is one of `ok`, `fail`, `timeout`, `quota`, `blocked`, `awaiting_approval`, `rejected`, `cancelled`, `lost`.

**Silence alarms.** The thing `cron` cannot do. Every job carries a window, two missed slots wide by default. Past it, the job turns up in `shopfloor doctor`, in the morning digest, in the web board, and in `/api/health` as a 503 your own monitoring can poll. Four kinds of quiet are caught: no finished run inside the window, a slot that passed with nothing picking it up, two failures in a row, and a dead man's switch that stopped pinging.

**Money ceilings.** A daily cap for the whole shop and a cap per worker. The `claude_local` adapter reads back the cost the CLI reports, so the numbers are measured rather than guessed. Over the cap, the run is recorded as `blocked` instead of starting.

**Quota patience.** When an agent CLI says the plan is out of room, the run is marked `quota` and the job is pushed out half an hour, with no retry storm and no false failure.

**Approval gates.** A job marked `--approval` creates a run that waits. Approve it from the web interface or the command line and it goes through. Reject it with a note and the reason stays in the log. Mail, posts and deploys belong here.

**A morning digest.** One text with what needs attention, what waits for a decision, what ran, what failed and what it cost. `notifyCommand` in the config receives it on standard input, so Telegram, mail, a file or a desktop banner all work without this project growing a dependency.

**A web interface.** Board, approvals, runs with full output, workers, digest. Served from `src/ui`, three files, no build step, local only unless you change the host.

## Adapters

| adapter | what it runs | cost | notes |
| --- | --- | --- | --- |
| `process` | any shell command | 0 | your scripts stay yours |
| `claude_local` | the local `claude` CLI, headless | read from the CLI | plan sign-in or `CLAUDE_CODE_OAUTH_TOKEN`, no API key |
| `codex_local` | the local `codex` CLI | not reported | reads the sign-in in `~/.codex/auth.json` |
| `http` | a webhook on another machine | 0 | judged by the response status |

A headless agent run has nobody to click an allow button. Give `claude_local` an `--allow-tools` list, or `--skip-permissions` when you know what that means. The gate that protects you is the approval step in front of the job.

## Running it for real

Keep `shopfloor serve` alive and it both serves the interface and ticks the scheduler. On macOS a `launchd` plist is in `examples/`. Elsewhere, a unit file or a `tmux` window does the same.

If you would rather not keep a process alive, let the system scheduler call one pass.

```
*/5 * * * * /usr/local/bin/node /path/to/shopfloor/bin/shopfloor.mjs tick
```

## Security

It binds to `127.0.0.1` and asks for nothing. That is the right setting for a laptop and the wrong one for a shared machine, so set a token before you move the host.

```bash
shopfloor config token "$(openssl rand -hex 16)"
shopfloor config host 0.0.0.0
```

The token guards every `/api/` route. The heartbeat route is guarded by its own secret, because an outside process has to reach it with one `curl` and no headers. Shopfloor runs commands you put in it, so treat the config and the database as what they are, a list of things that will run as you.

## Configuration

`~/.shopfloor/config.json`, all optional.

| key | default | meaning |
| --- | --- | --- |
| `host`, `port` | `127.0.0.1`, `7420` | where the interface listens |
| `token` | `null` | bearer token for the api |
| `tickSeconds` | `20` | how often the scheduler looks around |
| `maxConcurrentRuns` | `2` | runs allowed at once |
| `maxUsdPerDay` | `5` | ceiling for the whole shop |
| `defaultTimeoutSec` | `900` | per run, unless the job says otherwise |
| `retryAfterQuotaSec` | `1800` | how long to wait out a hit quota |
| `keepRunOutputChars` | `20000` | tail of output kept per run |
| `keepRunDays` | `90` | run history kept |
| `digestAt` | `07:30` | when the daily digest is written |
| `notifyCommand` | `null` | shell command that receives the digest |

## Importing a shop in one file

```bash
shopfloor import examples/shop.json
```

See `examples/shop.json` for the shape.

## Tests

```bash
node --test
```

Twenty five tests over the schedule grammar, the run lifecycle, timeouts, budget ceilings, approval gates, silence detection, heartbeats and the http api. No test needs the network.

## What it is not

Not an agent framework. It does not write prompts, split tasks or route between models. Not a hosted service, because nothing leaves the machine. Not a replacement for a serious queue, as a single process with a SQLite file is honest about its size.

## Licence

MIT. Built by [Kalmár Dániel](https://www.kdconsulting.hu), AI consultant, with Claude Code.
