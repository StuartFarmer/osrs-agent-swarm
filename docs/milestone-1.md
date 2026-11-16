# Milestone 1 runbook

The goal is ten visible agents with independently programmable observations, memory, and context construction. The operator's three-character social smoke passed; the paid ten-agent milestone run is still pending. Do not treat the acceptance checker or skipped live tests as proof of a functioning swarm.

For the containerized swarm, use the **[Docker run guide](container.md)**. The native installation commands below remain available for development. Docker includes the server, clients, harness, recorder, and a desktop you can view in your browser.

## Install and verify

Use Node 24, Bun >=1.3.14, and Python 3.10+. Recording and its media tests also require FFmpeg (with libx264 and drawtext) and ffprobe on PATH; on macOS install these with `brew install ffmpeg`. From this checkout:

```sh
rtk git submodule update --init --recursive vendor/rs-sdk
rtk npm install
rtk proxy sh -c 'cd vendor/rs-sdk && bun install --frozen-lockfile'
rtk npm run check
```

The reviewed package lock is checked in and used by the container's `npm ci`. The submodule revision is 3aa493c3d26680df5bae2b475cc1805e3db05ae3. The compatibility test requires Node 24 and imports the actual SDK and Pi. Live runs reject the wrong Node/Pi versions.

Puppeteer downloads a browser during installation. To use an existing Chromium instead, install with PUPPETEER_SKIP_DOWNLOAD=true and set CHROMIUM_PATH to its executable when starting clients. On this machine that executable is /Applications/Chromium.app/Contents/MacOS/Chromium.

## Prepare a disposable local world

```sh
rtk npm run swarm -- world create m1smoke
rtk npm run swarm -- world start m1smoke
rtk proxy env SWARM_LIVE_GAME=1 SWARM_SMOKE_WORLD=m1smoke node --import tsx --test tests/live/social.test.ts
```

Creation clones the pinned vendor checkout, installs frozen upstream dependencies, runs the SQLite migration and builds, and checks effective 400 ms / 1x XP settings. It refuses an existing world directory. Failed preparation leaves files for diagnosis; use a new world ID rather than deleting saves.

The launcher sets `BUILD_VERIFY=false` for builds and runtime repacking, matching the pinned upstream Dockerfile: RS-SDK's custom content differs from the original cache checksums. The Git revision check and packer validation still run. If an older launcher left an incomplete world after a checksum error, preserve that directory under another name before recreating the original world ID.

A guarded patch in managed world copies initializes constants and parameter definitions even when the upstream packer reuses cached configs. Without it, rebuilding model flags can fail on `param=damagetype,^crush_style`. Creation and startup apply this patch; the vendor checkout stays unchanged. An existing directory without the top-level `world.json` is now reported as incomplete preparation, with its files preserved. The `m1` world affected during setup was completed in place after successful engine/client builds, migration checks, and effective-setting verification.

The disposable copy receives explicit loopback listener patches and a guarded gateway status field exposing its login-server connection. `world start` waits for that connection before returning; it upgrades existing managed world copies on their next start. The web transport worker is disabled for this POC so the audited loopback listener handles web traffic. The vendor and reference checkouts are unchanged. The operator has now passed the social smoke against a running world; fresh setup remains blocked inside the coding sandbox.

The smoke test prints `[browser]` and `[smoke]` progress as Chrome starts, each tab opens, and each character connects. A cold Chrome launch may take up to 60 seconds before tabs open. Startup failures release the world lock so the test can exit.

Preparation accepts characters already on the mainland. For characters still on Tutorial Island, it repeats bounded tutorial steps until the observed location leaves the tutorial area and retains SDK failure details.

New characters receive randomized appearance through the upstream tutorial helper when the creation interface is open. Existing characters keep their appearance. Random selection makes agents easier to distinguish but does not guarantee every outfit is unique; video labels identify the agent regardless.

The smoke test creates three rendered characters, skips the tutorial, and checks public chat, private-message recipient isolation, follow/stop, inventory deltas from a two-sided trade, and drop/pickup. It records observations, action journals, and a screenshot. No LLM is used. An ordinary gathering/banking/shop route still needs live calibration and verification; tool presence alone is not that proof.

Stop the smoke world and close its dedicated browser before starting another world on the same ports:

```sh
rtk npm run swarm -- world stop m1smoke
rtk npm run swarm -- world create m1
rtk npm run swarm -- world start m1
rtk npm run swarm -- clients start --experiment experiments/openrouter-m1.json
```

The POC uses fixed loopback ports 8888, 8898, 7780, 43594, 43500, 45099, and 43501; run one world at a time. Each world has its own accounts, saves, logs, and browser profile under .local/worlds. The launcher sets `WEBSITE_REGISTRATION=false` so the local login server creates new accounts on first authenticated connection. New bot accounts share the password `admin`, which satisfies the local client's 1–20 character limit. Saved rosters retain their credentials; changing an existing account requires updating both `accounts.json` and its login database hash. Existing tabs reload if their stored credentials change. Browser connections are separate from SDK controllers. Focusing/capturing a tab does not log in a second client or steal control.

## Collect agent names

Run the standard-library Python collector directly if more names are needed. The existing pool contains 3,998 unique names collected by the operator; it is already sufficient for the first ten agents. With no page limit the script traverses the discoverable skill and activity categories in the main Old School hiscores instance, following pagination to the end of each category:

```sh
python3 scripts/collect_hiscore_names.py
python3 scripts/collect_hiscore_names.py --status
```

Each page commits deduplicated, game-normalized names and a checkpoint to `.local/hiscores/names.sqlite`. Ctrl-C stops collection; rerun the same command to resume. Categories are visited in rotation, so you get names from different activities early. To collect a bounded initial pool while testing, use `--max-pages 200`, then rerun without the limit for the remainder. Requests are sequential with a minimum two-second delay. HTTP blocks, throttles, malformed pages, and repeated pages stop the collector with its checkpoint retained.

Collect names **before** `clients start` for a new world. New rosters automatically use a populated default pool, reserving names uniquely across worlds. Set `SWARM_NAMES_DB=/absolute/path/names.sqlite` to require a particular pool. Existing `accounts.json` files retain their identities; do not delete them to rename characters. The smoke world's accounts therefore remain unchanged. If the default pool is absent or empty, startup logs that it is using synthetic names; an explicitly configured missing or empty pool fails instead.

This collects public display names, not login identities. Separate seasonal/ironman hiscores instances are outside the requested main leaderboard. Rankings can change during a long crawl, so the result is a deduplicated collection over time, not a simultaneous snapshot or a list of every OSRS account. The operator stopped after 217 pages across 114 discovered categories and accepted that pool; a complete crawl is unnecessary for this test. If live markup differs, the collector stops rather than silently claiming completion.

## Configure inference

The selected preset is `experiments/openrouter-m1.json`: ten agents using OpenRouter, `deepseek/deepseek-v4.1-flash-1017`, and a **$5 maximum ledger budget** for the first test. Supply `OPENROUTER_API_KEY` in the process environment through your usual secret manager. It is currently absent; no paid request has been made. Never put the key in a checked-in file or agent context.

The model identifier was checked against [OpenRouter's model metadata](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash-1017/endpoints). The preset requests disabled reasoning, price-sorted routing, no provider fallbacks, and support for all request parameters. It caps input at $0.05 and output at $0.50 per million tokens and per-request fees at zero, using [OpenRouter's routing controls](https://openrouter.ai/docs/guides/routing/provider-selection). These are conservative accounting tariffs and routing ceilings, not a promise of one provider's exact billing rate. If no endpoint qualifies, the request fails; the harness does not relax the ceilings automatically.

The gate reserves a conservative maximum before dispatch, holds capacity through stream settlement, and keeps the reservation when usage is unknown. Failed pre-dispatch work is settled to zero. There are no automatic provider retries. Resume preserves spending and reservations. The harness's $5 enforcement depends on the endpoint honoring its token/price controls and reporting usage correctly; use an OpenRouter key with a $5 credit limit as the billing backstop.

The model's [reasoning control](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) is explicitly disabled in the serialized request. Only Chat Completions models with bounded billed output are supported. The current serializer test uses a fake HTTP response through the installed Pi implementation; actual endpoint behavior remains a live-test gate.

For another endpoint, copy `experiments/m1.json` to an ignored local experiment, retain paths relative to the project root, and set an explicit model object with `provider`, `modelId`, `baseUrl`, `apiKeyEnv`, `contextWindow`, `costLimitUsd`, `zeroCost`, and per-million-token `rates` (`input`, `output`, `cacheRead`, `cacheWrite`). `provider` supports `openrouter` or `openai-compatible`. All-zero paid tariffs are rejected; a genuinely unmetered endpoint needs `zeroCost: true` and zero rates.

## Operate a run

For the first 30-minute recorded experiment after the social smoke, close the smoke world's dedicated Chrome window, then run the following from the `typescript-poc` checkout in zsh. `world create m1` is a one-time step; if that world already exists, keep it and skip creation.

```sh
nvm use 24
npm run swarm -- world stop m1smoke
npm run swarm -- world create m1
npm run swarm -- world start m1
npm run swarm -- clients start --experiment experiments/openrouter-m1.json
read -rs 'OPENROUTER_API_KEY?OpenRouter API key: '
export OPENROUTER_API_KEY
npm run swarm -- run --experiment experiments/openrouter-m1.json --record
```

The hidden prompt keeps the key out of shell history; skip it if your environment already supplies the key. The experiment uses ten accounts, a 1,800-second duration after preparation, four concurrent model calls, and a $5 ledger cap. New accounts draw from the collected name pool and share the password `admin`. Look for `[run] RUN_ID` in the terminal; recordings and traces are saved under that run directory.

```sh
rtk npm run swarm -- run --experiment experiments/openrouter-m1.json
rtk npm run swarm -- status --run RUN_ID
rtk npm run swarm -- memory get --run RUN_ID --agent agent1
rtk npm run swarm -- memory set --run RUN_ID --agent agent1 --expected-revision 2 --file .local/memory.json
rtk npm run swarm -- focus --run RUN_ID --agent agent1
rtk npm run swarm -- capture --run RUN_ID --agent agent1
```

The run ID is the new directory under runs/. All characters must become ready and finish preparation before the 30-minute clock starts. Initial skills, equipment, and inventories must match. Instruction/profile edits apply at the next task boundary; invalid edits retain the last valid revision and are logged.

Ctrl-C drains the harness and disconnects SDK controllers. It leaves the world and rendered clients open. Resume using the same experiment:

```sh
rtk npm run swarm -- run --experiment experiments/openrouter-m1.json --resume RUN_ID
```

Resume retains the original deadline, memory, spending, and uncertain effects; downtime counts. It never reruns an unfinished action automatically. Report task totals include tasks completed before the restart. Module code edits require this harness restart. Only one harness may own a world's controllers. Ownership uses a loopback lock listener that the OS releases on process exit; a port conflict refuses the run.

Closing a character tab records unavailability while other agents continue. Restore it using clients start with the same experiment. New state must arrive before another request/action can proceed.

Each task gets at most 8 requests, 16 executed tools, and 120 seconds. Global inference concurrency is 4. Agents share the same tools and scheduling policy. A task starts with a fresh transcript while private memory and selected history persist.

## Record a rotating game video

Start the run with recording enabled:

```sh
rtk npm run swarm -- run --experiment experiments/openrouter-m1.json --record
```

Or attach a recorder in another terminal after an existing run finishes character preparation:

```sh
rtk npm run swarm -- record --run RUN_ID
```

The recorder focuses each existing game tab for 30 seconds, cycling through all ten for the experiment's remaining duration. Ten agents make a five-minute cycle, repeated six times over a full 30-minute run. All agents continue executing while their tabs are off-screen. The video captures the game canvas at a target 10 fps with agent/name/world labels and an elapsed video clock; it excludes the browser URL and credential fields. Each invocation creates:

```text
runs/RUN_ID/recordings/recording-UUID/
  session.mp4
  timeline.jsonl
  recording.json
  encoder.log
```

The timeline records each agent switch and captured frame with wall-clock timestamps and video offsets, allowing comparison with the agent trace timestamps. Off-screen agents have no video during their gap; their traces still run. This is a visual sample of the experiment, not full-world replay.

Recording ends at the original run deadline. Ctrl-C finishes the current MP4; with `run --record` it also stops the harness, while standalone `record` stops only the recorder. Standalone recording otherwise continues until the saved deadline even if the harness exits early. Resuming with `--record` creates another segment and retains the original run deadline. Only one recorder may own a run. Capture or encoding failures stop an automatically recorded run; they do not silently leave it running without video. Recording bytes count toward the existing artifact quota. Fragmented MP4 preserves completed fragments if the process crashes, though the tail may be incomplete.

Short FFmpeg tests verify playback, rotation, timestamp alignment, and interruption. A full Chrome capture and 30-minute recording still need a live check.

## Customize agent code

Edit agents/gatherer.ts or agents/merchant.ts. You control code, not just instructions:

```ts
export const gatherer: AgentDefinition = {
  id: "gatherer",
  observe(observation) {
    const view = domainView(observation, [
      "position",
      "inventory",
      "nearby",
      "interfaces",
      "bank",
      "shop",
    ]);
    // Chat is excluded from every model-facing read path for this policy.
    view.derived.freeSlots = 28 - observation.raw.inventory.length;
    return view;
  },
  async buildContext(input) {
    const memory = input.memory.read();
    const history = input.history.search("action_outcome", 5);
    return [
      tableau(input, {
        recentOutcomes: history,
        currentPlan: memory.value.plan,
      }),
      ...input.taskMessages,
    ];
  },
};
```

observe selects complete domains and computes derived facts. buildContext can retrieve private memory/history and arrange the model's messages. Preserve complete tool-call/result exchanges in taskMessages. The runtime validates those exchanges and the full request's byte ceiling. It samples live state after waiting for an inference slot and rebuilds before each follow-up.

To add a third module, create agents/YOUR_NAME.ts, register it in src/run.ts definitions, and extend AgentEntry's definition union and the registry validation in src/config.ts. This is a trusted operator-code boundary; model outputs cannot import modules or execute arbitrary code. There is no filesystem or shell tool.

Agent memory is revisioned plan/beliefs/relationships/nextAction. Game-owned money and inventories cannot be overwritten through memory. History deliberately exposes private memory revisions and reduced action outcomes; full operator traces are not searchable by models. A policy change cannot erase information already stored in an agent's own memory.

Tools require exact observed references and a recent observation stamp. Changed slots, entities, dialogue pages, or trade offers are refused. Drop targets an exact inventory slot and supports whole stacks only; partial-stack drops are refused because the SDK primitive drops the complete slot. Primitive dispatch revalidates live targets and the experiment freshness limit immediately before sending. A trade acceptance approves one screen only. “Dispatched” means sent to the client; it is not proof of a completed game effect.

Context includes at most 20 pending-action summaries. Agents can page `pending_actions` and call `inspect_action` to inspect their own policy-filtered intent against fresh observations. A matching postcondition can resolve an action without replaying it; this records observed state, not causal proof that the particular action produced it. Unsupported or ambiguous outcomes remain uncertain.

## Inspect traces and acceptance

For each agent, runs/RUN_ID/agents/WORLD_ID/AGENT_ID contains:

- events.jsonl: ordered events exported from SQLite, with task/request/action IDs.
- REQUEST_ID.json: actual serialized Pi Context, tool schemas, non-secret options, model, and observation/profile revision.
- PNG files: operator-requested or best-effort failure captures, with honest capture timestamps.

SQLite is the recovery source. Concurrent CLI and harness exports serialize through a database write lock so event sequences cannot overlap. Credentials are redacted in the recovery journal as well as exported artifacts. Intent is committed before a game effect, and context is written before provider dispatch. Incomplete final JSONL lines are recoverable; interior corruption stops export. Artifact quota includes SQLite/WAL and screenshots; new work stops when it cannot be recorded.

For the demo, edit instructions during the run, restart/resume the harness, and close/restore one tab. Capture a screenshot and inspect every agent's saved context. Then validate the preserved evidence:

```sh
rtk proxy env SWARM_LIVE_GAME=1 SWARM_LIVE_LLM=1 SWARM_LIVE_RUN_ID=RUN_ID SWARM_SMOKE_WORLD=m1smoke node --import tsx --test tests/live/ten-agents.test.ts
rtk npm run swarm -- report --run RUN_ID
```

The live acceptance test evaluates an already operated CLI run; it does not silently buy a new 30-minute run. Missing live flags or run ID causes a skip. Missing agent activity, memory updates, context files, policy proof, social smoke, screenshot, or interventions causes a named failure. Exit codes: 0 success, 1 setup/config error, 2 incomplete acceptance/run.

The report does not claim profitability. Initial states and subsequent observations/tool results preserve evidence for later economic analysis. Full visual replay and headless viewing are deferred until the next milestone.
