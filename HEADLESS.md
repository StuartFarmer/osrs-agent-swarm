# Headless operation

The feature branch `feat/headless-swarm` runs one Bun lite client per character, using the pinned RS-SDK protocol client without a browser or renderer. One game world is shared by the agents. Upstream supports multiple worlds; deploying independent experiments can be added later without changing this client mode.

The initial preset is `experiments/headless-m1.json`: ten RuneBench agents, normal 400 ms ticks, 30 minutes of wall time, four concurrent model requests, and a $5 ledger cap. Switching to headless does not itself accelerate game time. Setting 50 ms ticks requests 8× simulated time; actual speed must be measured. API latency and quotas do not accelerate with the engine.

## Ubuntu launch

Use the ordinary repository checkout on `feat/headless-swarm`. [Docker instructions](docs/container.md) cover building and persistence. Start with a fresh Compose project to preserve any existing rendered experiment:

```sh
docker compose -p swarm-headless build swarm
docker compose -p swarm-headless run --rm --service-ports swarm --view-only
```

This starts the world, clients, and viewer without inference or character preparation. Stop it with Ctrl-C before a paid launch. From your laptop, forward the viewer:

```sh
ssh -L 6080:127.0.0.1:6080 user@concepcion
```

Open <http://localhost:6080/mapview/>. It shows live player positions on the world map. The proxy also exposes `ws://localhost:6080/worldfeed` for an external 3D viewer such as upstream rs-world; that viewer is not bundled or compatibility-tested here. Viewing does not log in as an agent or consume its session. This is not a full rendered game canvas, inventory inspector, or video recording. The map's optional historical player-trace route is deliberately not exposed.

The map centers on the first player when positions arrive. Use the player selector or **Center on player** to find a character; the status shows coordinates, level, total players, and how many share the selected tile. New characters often overlap on Tutorial Island, appearing as one yellow dot. Position updates preserve your camera position after the initial centering. Drag to pan and scroll to zoom. Connection failures are shown as stale-position warnings instead of silently presenting old markers as current. A `--view-only` launch leaves characters unprepared and does not run their AI.

Only spectator/cache routes are forwarded; game login, SDK control, and management endpoints stay private. Compose publishes only `127.0.0.1:6080`. The native viewer also binds loopback.

## Native commands

Install Node 24, Bun 1.3.14 or later, Python 3.10+, and the dependencies documented in the README. From the repository root:

```sh
npm run swarm -- world create m1
npm run swarm -- world start m1 --tick-ms 400
npm run swarm -- clients start --experiment experiments/headless-m1.json
npm run swarm -- view --world m1
```

The last command keeps the viewer in the foreground. In another terminal, export the configured model credential and start the harness:

```sh
npm run swarm -- run --experiment experiments/headless-m1.json
npm run swarm -- world stats
npm run swarm -- status --run RUN_ID
npm run swarm -- report --run RUN_ID
```

Ctrl-C on the harness stops inference and drains SDK work, leaving client sessions and the world running. Resume with `run --experiment experiments/headless-m1.json --resume RUN_ID`. The original wall-clock deadline and spending ledger remain in force; downtime counts against the duration. Configuration changes require a new experiment. After inspecting state, explicitly restart failed clients with `clients start` before resuming; uncertain actions are not automatically replayed. A fleet process check runs every five seconds, and task admission also checks session ownership.

Stop clients before stopping the world:

```sh
npm run swarm -- clients stop --experiment experiments/headless-m1.json
npm run swarm -- world stop m1
```

Browser and headless clients cannot own the same world's sessions simultaneously. `focus`, `capture`, and `record` apply only to browser runs. Client logs live under `.local/worlds/m1/lite-AGENT_ID.log`; the engine log is alongside them. Startup cancellation rolls back newly created clients while preserving existing sessions.

## Calibration on concepcion

The supplied report shows 28 physical cores / 56 threads across two Xeon E5-2690 v4 sockets, 125 GiB RAM, and 111 GiB available after the competing load was addressed. The sampled CPU intervals were 80–99% idle. The root filesystem has 235 GiB free; the physical 7 TiB device is not evidence that all of it is mounted and available for traces. Compose currently limits the container to 32 GiB and does not cap CPU use.

1. Check ten headless sessions at 400 ms without inference. Inspect memory, client logs, and `world stats` for engine timing.
2. Run the social smoke on a disposable world at 400 ms, then 200, 100, and 50 ms. Stop the prior world first: native ports are fixed. Create a fresh world ID for each test so the initial character state is reproducible.
3. Run a small paid experiment after those checks pass. Change `world.tickMs` in a copied experiment and start the world with the same value. In Docker, select that experiment with `SWARM_EXPERIMENT=experiments/YOUR_FILE.json` and a fresh Compose project. Only one project can bind host port 6080 at a time.
4. Increase population in stages, e.g. 10, 50, 100, 250, 500, 1,000. Give each agent a unique ID. Measure resident memory, CPU, engine over-budget ticks, achieved simulation speed, API queuing/errors, and trace growth. Start a new experiment for each configuration.

Example social smoke, with no model calls (choose a new world ID per tick rate):

```sh
npm run swarm -- world create smoke400
npm run swarm -- world start smoke400 --tick-ms 400
SWARM_LIVE_GAME=1 SWARM_CLIENT_MODE=headless SWARM_SMOKE_WORLD=smoke400 \
  node --import tsx --test tests/live/social.test.ts
npm run swarm -- world stop smoke400
```

The smoke tests public chat, DM isolation, follow/stop, trade inventory deltas, and drop/pickup. It writes evidence in the world's directory and stops its headless clients. After operating an experiment, collect policy evidence and validate it against a smoke test at the same tick rate:

```sh
SWARM_LIVE_GAME=1 SWARM_LIVE_LLM=1 SWARM_LIVE_RUN_ID=RUN_ID SWARM_SMOKE_WORLD=smoke400 \
  node --import tsx --test tests/live/ten-agents.test.ts
npm run swarm -- report --run RUN_ID
```

Despite its historical filename, this acceptance test supports headless populations other than ten. It checks an existing run and makes no model calls. It copies smoke evidence and runs the local policy test; missing activity or evidence fails acceptance.

## Evidence and limits

Each run retains its manifest, SQLite ledger, per-agent JSONL events, model request context, tool results, private memory, and initial state. `execute_code` journals pair script start/result/failure with an action ID. An interrupted script can already have changed the game; `uncertain` failure evidence is a prompt to inspect state. Script journals do not record every internal SDK operation and do not provide deterministic game replay.

`report.json.worldTiming` records configured tick duration, observed engine ticks, wall time, and achieved speed relative to the 400 ms baseline. Timing covers the latest harness attachment segment; `world_start` and `world_end` events retain segment evidence and engine epoch. The world feed is a live, potentially lossy visual stream, not an authoritative audit log; its upstream omissions include ground items and some dynamic location changes.

The schema permits 1–1,000 headless agents, 50–400 ms ticks, up to seven wall-clock days, and up to 100 GiB of run artifacts. These are configuration bounds, not demonstrated capacity. The engine's serial simulation remains a shared-world bottleneck. One lite process and one SDK executor per RuneBench character consume memory and CPU; 1,000 characters on this machine require measurement. External API throughput, spend, and crowded observations may limit useful progress before the engine does.

Existing SDK waits mix wall time and game ticks, and SDK worker state publication remains at its existing cadence. Acceleration must pass behavioral tests; a 50 ms setting alone is not evidence of 8× useful agent throughput. Trace quota checks still scan artifact files and event export still rereads prior JSONL, so long runs can become storage/CPU bound. Multi-day and 1,000-agent experiments remain unvalidated until these costs are measured and addressed if necessary.

Offline tests exercise configuration, lifecycle, session loss, timing reports, and spectator route restrictions. Live Linux/Bun startup, the external 3D viewer, accelerated social behavior, and server capacity still require the calibration above.
