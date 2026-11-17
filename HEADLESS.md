# Headless operation

The feature branch `feat/headless-swarm` runs one Bun lite client per character, using the pinned RS-SDK protocol client without a browser or renderer. One game world is shared by the agents. Upstream supports multiple worlds; deploying independent experiments can be added later without changing this client mode.

The recommended launcher is `./swarm`: 25 RuneBench agents, 25 concurrent external model requests, normal 400 ms ticks, 30 minutes of wall time, and a $5 ledger cap. The original ten-agent smoke preset remains available as `experiments/headless-m1.json`. Switching to headless does not itself accelerate game time. Setting 50 ms ticks requests 8× simulated time; actual speed must be measured. API latency and quotas do not accelerate with the engine.

## Ubuntu launch

From `~/osrs-bot-swarm-headless`:

```sh
./swarm
```

Docker builds the game, cache assets, and 3D viewer, then serves everything on port 6080. The launcher privately prompts for the API key when needed and uses sudo for Docker if required. No host Bun, Yarn, Node, cache conversion, or separate viewer process is needed. The native sections below are only for development outside Docker.

Use `./swarm preview` for the world and viewer without inference, `./swarm logs` for startup/inference logs, and `./swarm stop` to save and stop. From your Mac, keep this tunnel running:

```sh
ssh -N -L 16080:127.0.0.1:6080 user@concepcion
```

Open **http://localhost:16080/watch/**. The same page shows the current world whether inference is active or stopped; the agent selector lists saved characters. Logs should say `opening 25 headless clients` and `Starting headless experiment` or `Resuming` for the 25-agent inference run. `View-only` means inference is disabled. Do not open a second tunnel if that port is already forwarded.

The remaining local URLs below use server port 6080; use laptop port 16080 through the tunnel.

Open <http://localhost:6080/watch/> for the **3D spectator and agent inspector**, or <http://localhost:6080/mapview/> for the 2D map. Docker bundles [RS World](https://github.com/MaxBittker/rs-world) pinned to `4b4df02829c0f31900535acae35a2707d265489c`, with cache assets converted from the same pinned engine build. Rendering runs in your browser; the game clients remain headless.

Select an agent in the header or the viewer's Live panel, or right-click a character and choose **Follow**. The scene selection and inspector stay synchronized. The inspector shows that character's inventory, equipment, skills, dialogue/interfaces, bank/shop/trade, messages, nearby entities, and full published SDK observation. Selecting a different agent clears the old observation and rejects late responses from the previous selection. Observation age and stale/disconnected status are visible.

This is a follow camera plus SDK state, **not a pixel-for-pixel client screen or the model's policy-filtered prompt**. Headless clients have no rendered canvas to mirror. The gateway's existing authenticated `GET /state/:username` supplies the observation without opening a controller connection or another game login. Only agents in this world's saved roster can be inspected; account passwords stay on the server. The inspector is read-only, including chat and trade. Other online characters can still be followed in 3D, but have no managed-agent inspector.

The 3D scene uses the engine's world feed at `/worldfeed`; it cannot reconstruct information missing from that feed. The map's optional historical player-trace route is deliberately not exposed. Viewer source and license details are served at `/viewer/UPSTREAM-REVISION.txt` and `/viewer/UPSTREAM-LICENSE.txt`.

The map centers on the first player when positions arrive. Use the player selector or **Center on player** to find a character; the status shows coordinates, level, total players, and how many share the selected tile. New characters often overlap on Tutorial Island, appearing as one yellow dot. Position updates preserve your camera position after the initial centering. Drag to pan and scroll to zoom. Connection failures are shown as stale-position warnings instead of silently presenting old markers as current. A `--view-only` launch leaves characters unprepared and does not run their AI.

Only spectator/cache routes and the roster-scoped read-only observation API are exposed; game login, SDK control, and management endpoints stay private. Compose publishes only `127.0.0.1:6080`. The native viewer also binds loopback.

## Shared UI styling and the actual client view

The inspector shell reuses the pinned viewer's `OSRS Bold` / `OSRS Small` fonts, textured panel background, six-pixel border image, and button styles. `scripts/prepare-viewer.mjs` exports only those rules and their assets into `/viewer/swarm-theme/`; it excludes upstream body/layout and text-selection resets. Docker includes this automatically. Text remains selectable, long observations scroll, and the sidebar stacks below the scene on small screens.

More reusable material is already in the pinned sources:

- `references/rs-world/src/index.css` and `src/media/`: fonts, border and background images.
- `references/rs-world/src/live/LivePanel.css`, `InfoPanel.css`, and `src/components/rs/`: panel, button, menu, searchable React selector, minimap, world map, and loading UI. `OsrsSelect.tsx` uses the viewer's existing `react-select` dependency; it cannot be imported directly into the shell's plain HTML without bundling it.
- `vendor/rs-sdk/server/webclient/src/client/Client.ts`: loads `invback`, `chatback`, `mapback`, and `sideicons` from the packed media archive, and draws the real sidebar, chat and interfaces.
- `vendor/rs-sdk/server/webclient/src/graphics/Pix8.ts`, `Pix32.ts`, `PixFont.ts`, and `src/config/IfType.ts`: decoders and drawing code for original sprites, bitmap fonts, and interface layouts. The original game's UI is drawn on canvas from cache assets; it is not a reusable CSS stylesheet. Use the same engine cache revision when exporting those assets.

An exact client view is possible when the agent runs a **rendered browser client**: our existing rendered mode exposes that actual desktop/client through noVNC. It incurs rendering costs and the current browser preset is limited to ten agents. The present fleet is entirely lite clients; mixed rendered/headless sessions are not supported by our launcher.

The lite client explicitly has no canvas and does not fetch models/textures. Its gateway observer sessions expose SDK state, not a complete rendered client. Logging a browser into the same character replaces its game connection, and the gateway disconnects the old bot session; the harness detects that loss. Do not use a second login as a spectator for a running headless agent.

A future **passive client mirror** could reuse the original browser renderer without another game login, but it is not present in the pinned source. It would need a complete initial client state, subsequent packet/state updates, cache loading, and suppression of gameplay output. Joining only the incremental packet stream midway through a session is insufficient. It also needs local-only tab/camera interaction to inspect stats without changing the agent's actions. This is an engineering option, not a tested capability.

The smaller option is to render original-looking stats/inventory/chat panels from the SDK observations already available, reusing cache sprites and interface definitions where practical. This preserves headless execution but remains an observer UI rather than an exact client-screen mirror.

## Grow the existing world to 25 agents

After updating the source and rebuilding the image, select `experiments/headless-25.json` and a new run name. This preset uses 25 independent agents and up to 25 concurrent external model requests. It retains the 30-minute duration, 400 ms ticks, and $5 ledger cap. Agents 11–25 reuse the existing role/instruction templates; their characters, conversations, and private memory are independent.

Run on concepcion from `~/osrs-bot-swarm-headless`, with `OPENROUTER_API_KEY` already exported:

```sh
export SWARM_EXPERIMENT=experiments/headless-25.json
export SWARM_RUN_NAME=scale25
sudo --preserve-env=OPENROUTER_API_KEY,SWARM_EXPERIMENT,SWARM_RUN_NAME \
  docker compose -p swarm-headless -f compose.yaml up -d --no-build --force-recreate swarm
sudo docker compose -p swarm-headless logs --tail 100 -f swarm
```

Keep the same Compose project and volume. Recreating the container gracefully stops the previous run, saves the world, and restarts its clients. Existing agent IDs retain their account names, credentials, and game progress. Missing IDs get new accounts. Removing an ID from a later experiment leaves its saved character intact. Changing the active fleet currently requires a restart; this does not add agents to an already-running harness.

`SWARM_RUN_NAME` identifies an experiment's persisted run pointer, not a new world. Reusing `scale25` resumes that run with its original deadline and ledger; changing it deliberately starts a new run with its own duration and spending cap. Previous run directories and pointers remain intact. A new run starts fresh agent conversations/private memory while retaining character progress. Leave the name unset to select the original unnamed run. Each name requires an unchanged experiment configuration on resume.

To grow further, copy the preset and add entries with unique agent IDs; profiles/instructions can be shared. Set `concurrency` independently of population. The former four-request setting was a smoke-test default: external inference waits on the API, while local CPU runs the engine, clients, and tools. More in-flight calls can improve throughput but also encounter provider limits and consume the budget sooner. The pinned engine has 2,046 simultaneous player slots per world; actual CPU, memory, and API capacity still need measurement.

Account updates use a short exclusive `accounts.json.lock` file and an atomic roster replacement. If the process crashes during an update, stop all roster writers before removing that stale lock; do not delete `accounts.json` or character saves.

## Native commands (development without Docker)

Skip this section for the Docker deployment.

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
3. Run a small paid experiment after those checks pass. Change `world.tickMs` in a copied experiment and start the world with the same value. In Docker, select that experiment with `SWARM_EXPERIMENT=experiments/YOUR_FILE.json`. Use a new `SWARM_RUN_NAME` to retain world progress, or a fresh Compose project for an independent world. Only one project can bind host port 6080 at a time.
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

The schema permits 1–2,046 headless agents, 50–400 ms ticks, up to seven wall-clock days, and up to 100 GiB of run artifacts. These are configuration bounds, not demonstrated capacity. The engine's serial simulation remains a shared-world bottleneck. One lite process and one SDK executor per RuneBench character consume memory and CPU; 1,000 characters on this machine require measurement. External API throughput, spend, and crowded observations may limit useful progress before the engine does.

Existing SDK waits mix wall time and game ticks, and SDK worker state publication remains at its existing cadence. Acceleration must pass behavioral tests; a 50 ms setting alone is not evidence of 8× useful agent throughput. Trace quota checks still scan artifact files and event export still rereads prior JSONL, so long runs can become storage/CPU bound. Multi-day and 1,000-agent experiments remain unvalidated until these costs are measured and addressed if necessary.

Offline tests exercise configuration, lifecycle, session loss, timing reports, static-file containment, observation authorization/redaction, and selection synchronization. The pinned 3D viewer compiles locally with its existing upstream warnings, and revision-289 cache conversion was checked. Browser rendering against the live server, accelerated social behavior, and server capacity still require validation.

## Update the existing preview on concepcion

The `swarm-headless` Compose project owns the existing state volume. Keep the deployment directory `~/osrs-bot-swarm-headless` so host-mounted traces and collected names also stay in place. After pushing the feature branch, run on the server:

```sh
release_dir=$(mktemp -d)
git clone --depth 1 --single-branch --branch feat/headless-swarm \
  https://github.com/StuartFarmer/osrs-agent-swarm.git "$release_dir/source"
rsync -a --exclude=.git "$release_dir/source/" ~/osrs-bot-swarm-headless/
cd ~/osrs-bot-swarm-headless
sudo docker compose -p swarm-headless -f compose.yaml -f compose.preview.yaml build swarm
```

The temporary clone supplies source files only; rsync does not delete saved data. Build before stopping the existing preview. Stop the old foreground `--view-only` command with Ctrl-C, or stop its specific container name shown by `sudo docker ps`. Then relaunch as a regular Compose service:

```sh
sudo docker compose -p swarm-headless -f compose.yaml -f compose.preview.yaml up -d --no-build swarm
sudo docker compose -p swarm-headless logs --tail 100 -f swarm
```

`compose.preview.yaml` keeps inference disabled and makes ordinary Compose logs work, avoiding the separate one-off `run` container. The existing saved world is reused; do not use `down --volumes`. Keep your SSH tunnel and open <http://localhost:16080/watch/> when forwarding laptop port 16080. Rebuilding changes the image, so an already-running old container must be replaced before the new viewer appears.

To start a paid experiment later, export the model key and explicitly return to the base Compose configuration. If using sudo, preserve only that named credential variable:

```sh
sudo --preserve-env=OPENROUTER_API_KEY docker compose -p swarm-headless -f compose.yaml up -d --force-recreate swarm
```

## Native 3D viewer build (development without Docker)

**Skip this section when using Docker.** Docker already converts the cache and serves the viewer. Its world cache lives inside the saved-state volume, so the native host path below will not exist for a Docker-only deployment.

Native `view` serves viewer assets from `.local/viewer`, or `SWARM_VIEWER_DIR` when set. To prepare them outside Docker, install Yarn Classic and run from the repository root after preparing world `m1`:

```sh
git clone https://github.com/MaxBittker/rs-world.git references/rs-world
git -C references/rs-world checkout 4b4df02829c0f31900535acae35a2707d265489c
node scripts/prepare-viewer.mjs references/rs-world
cd references/rs-world
yarn install --frozen-lockfile --ignore-scripts
bun scripts/sync-rs-sdk-cache.ts --pack ../../.local/worlds/m1/game/server/engine/data/pack --revision 289
CI=false PUBLIC_URL=/viewer GENERATE_SOURCEMAP=false yarn build
cp -R caches build/caches
cp LICENSE build/UPSTREAM-LICENSE.txt
cp ../../scripts/viewer-revision.txt build/UPSTREAM-REVISION.txt
cd ../..
SWARM_VIEWER_DIR="$PWD/references/rs-world/build" npm run swarm -- view --world m1
```

Use a clean checkout at the pinned revision; the bridge patch refuses unexpected source. The viewer's dependency scripts are disabled because its optional texture-export dependency is not required. Native builds can use the successful Node 24 toolchain; Docker uses the upstream viewer's Node 20 build environment and keeps those build dependencies out of the final image.
