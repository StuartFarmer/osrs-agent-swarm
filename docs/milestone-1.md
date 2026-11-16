# Milestone 1 runbook

The goal is ten visible agents with independently programmable observations, memory, and context construction. The current implementation has preliminary offline coverage; it has not yet run a local game or a paid model. Do not treat the acceptance checker or skipped live tests as proof of a functioning swarm.

## Install and verify

Use Node 24 and Bun >=1.3.14. From this checkout:

```sh
rtk git submodule update --init --recursive vendor/rs-sdk
rtk npm install
rtk proxy sh -c 'cd vendor/rs-sdk && bun install --frozen-lockfile'
rtk npm run check
```

A package lock must be generated and checked in after a successful installation; this environment could not reach npm or GitHub from the shell. The submodule revision is 3aa493c3d26680df5bae2b475cc1805e3db05ae3. The compatibility test requires Node 24 and imports the actual SDK and Pi. Live runs reject the wrong Node/Pi versions.

Puppeteer downloads a browser during installation. To use an existing Chromium instead, install with PUPPETEER_SKIP_DOWNLOAD=true and set CHROMIUM_PATH to its executable when starting clients. On this machine that executable is /Applications/Chromium.app/Contents/MacOS/Chromium.

## Prepare a disposable local world

```sh
rtk npm run swarm -- world create m1smoke
rtk npm run swarm -- world start m1smoke
rtk proxy env SWARM_LIVE_GAME=1 SWARM_SMOKE_WORLD=m1smoke node --import tsx --test tests/live/social.test.ts
```

Creation clones the pinned vendor checkout, installs frozen upstream dependencies, runs the SQLite migration and builds, and checks effective 400 ms / 1x XP settings. It refuses an existing world directory. Failed preparation leaves files for diagnosis; use a new world ID rather than deleting saves.

The disposable copy receives explicit loopback listener patches. The web transport worker is disabled for this POC so the audited loopback listener handles web traffic. The vendor and reference checkouts are unchanged. Startup commands and migrations remain **unverified against a running engine** until the above smoke test succeeds.

The smoke test creates three rendered characters, skips the tutorial, and checks public chat, private-message recipient isolation, follow/stop, inventory deltas from a two-sided trade, and drop/pickup. It records observations, action journals, and a screenshot. No LLM is used. An ordinary gathering/banking/shop route still needs live calibration and verification; tool presence alone is not that proof.

Stop the smoke world and close its dedicated browser before starting another world on the same ports:

```sh
rtk npm run swarm -- world stop m1smoke
rtk npm run swarm -- world create m1
rtk npm run swarm -- world start m1
rtk npm run swarm -- clients start --experiment experiments/m1.json
```

The POC uses fixed loopback ports 8888, 8898, 7780, 43594, 43500, 45099, and 43501; run one world at a time. Each world has its own accounts, saves, logs, and browser profile under .local/worlds. Browser connections are separate from SDK controllers. Focusing/capturing a tab does not log in a second client or steal control.

## Configure inference

Copy experiments/m1.json to a local ignored experiment, keeping agent paths relative to the project root. Replace model:null with an explicit configuration:

```jsonc
{
  "provider": "openai-compatible",
  "modelId": "YOUR_NON_REASONING_MODEL",
  "baseUrl": "https://YOUR_ENDPOINT/v1",
  "apiKeyEnv": "SWARM_MODEL_API_KEY",
  "contextWindow": 32768,
  "costLimitUsd": 5,
  "zeroCost": false,
  "rates": {
    "input": 0,
    "output": 0,
    "cacheRead": 0,
    "cacheWrite": 0,
  },
}
```

Those context-window and budget values are illustrative. Replace them with your chosen limits and replace the zero tariffs with the provider's actual per-million-token rates. All-zero paid tariffs are rejected. For a truly unmetered endpoint, explicitly use zeroCost:true with zero rates. The key stays in the named environment variable, never in the experiment or agent context.

Only Chat Completions models whose max_tokens bounds billed output are supported initially. Models that generate separately billed/unbounded hidden reasoning require a different validated adapter. The ledger estimates spending from declared tariffs; set a provider-side billing cap as well if you require a hard billing limit.

The gate reserves a conservative maximum before dispatch, holds capacity through stream settlement, and keeps the reservation when usage is unknown. Failed pre-dispatch work is settled to zero. There are no automatic provider retries.

## Operate a run

```sh
rtk npm run swarm -- run --experiment .local/m1.json
rtk npm run swarm -- status --run RUN_ID
rtk npm run swarm -- memory get --run RUN_ID --agent agent1
rtk npm run swarm -- memory set --run RUN_ID --agent agent1 --expected-revision 2 --file .local/memory.json
rtk npm run swarm -- focus --run RUN_ID --agent agent1
rtk npm run swarm -- capture --run RUN_ID --agent agent1
```

The run ID is the new directory under runs/. All characters must become ready and finish preparation before the 30-minute clock starts. Initial skills, equipment, and inventories must match. Instruction/profile edits apply at the next task boundary; invalid edits retain the last valid revision and are logged.

Ctrl-C drains the harness and disconnects SDK controllers. It leaves the world and rendered clients open. Resume using the same experiment:

```sh
rtk npm run swarm -- run --experiment .local/m1.json --resume RUN_ID
```

Resume retains the original deadline, memory, spending, and uncertain effects; downtime counts. It never reruns an unfinished action automatically. Module code edits require this harness restart. Only one harness may own a world's controllers. Ownership uses a loopback lock listener that the OS releases on process exit; a port conflict refuses the run.

Closing a character tab records unavailability while other agents continue. Restore it using clients start with the same experiment. New state must arrive before another request/action can proceed.

Each task gets at most 8 requests, 16 executed tools, and 120 seconds. Global inference concurrency is 4. Agents share the same tools and scheduling policy. A task starts with a fresh transcript while private memory and selected history persist.

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

Tools require exact observed references and a recent observation stamp. Changed slots, entities, dialogue pages, or trade offers are refused. A trade acceptance approves one screen only. “Dispatched” means sent to the client; it is not proof of a completed game effect.

## Inspect traces and acceptance

For each agent, runs/RUN_ID/agents/WORLD_ID/AGENT_ID contains:

- events.jsonl: ordered events exported from SQLite, with task/request/action IDs.
- REQUEST_ID.json: actual serialized Pi Context, tool schemas, non-secret options, model, and observation/profile revision.
- PNG files: operator-requested or best-effort failure captures, with honest capture timestamps.

SQLite is the recovery source. Intent is committed before a game effect, and context is written before provider dispatch. Incomplete final JSONL lines are recoverable; interior corruption stops export. Artifact quota includes SQLite/WAL and screenshots; new work stops when it cannot be recorded.

For the demo, edit instructions during the run, restart/resume the harness, and close/restore one tab. Capture a screenshot and inspect every agent's saved context. Then validate the preserved evidence:

```sh
rtk proxy env SWARM_LIVE_GAME=1 SWARM_LIVE_LLM=1 SWARM_LIVE_RUN_ID=RUN_ID SWARM_SMOKE_WORLD=m1smoke node --import tsx --test tests/live/ten-agents.test.ts
rtk npm run swarm -- report --run RUN_ID
```

The live acceptance test evaluates an already operated CLI run; it does not silently buy a new 30-minute run. Missing live flags or run ID causes a skip. Missing agent activity, memory updates, context files, policy proof, social smoke, screenshot, or interventions causes a named failure. Exit codes: 0 success, 1 setup/config error, 2 incomplete acceptance/run.

The report does not claim profitability. Initial states and subsequent observations/tool results preserve evidence for later economic analysis. Full visual replay and headless viewing are deferred until the next milestone.
