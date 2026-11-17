# Run the swarm in Docker

The default experiment uses true headless clients. Docker starts the game server, SDK gateway, Bun lite clients, and Pi harness, with a 3D spectator, agent inspector, and 2D map on port 6080. It does not launch Chromium, a desktop, or recording in this mode. The same image retains those dependencies for the optional rendered preset.

## Recommended launch

Run `./swarm` from the repository root. It builds and starts Docker with 25 agents, the 3D viewer, and inference; it prompts for the API key when needed. Use `./swarm logs`, `./swarm stop`, or `./swarm preview`. Docker handles all game/cache/viewer dependencies. From your Mac, keep `ssh -N -L 16080:127.0.0.1:6080 user@concepcion` running and open http://localhost:16080/watch/.

## Start the 30-minute test

The commands below are the manual ten-agent smoke setup. Use the launcher above for the recommended 25-agent run.

Run from the repository root on `feat/headless-swarm`. On Ubuntu, Docker with Compose is sufficient; native Node/Bun installations are not needed. Docker Desktop users should allocate at least 32 GiB to its VM. Compose currently caps container memory at 32 GiB; that is not a 1,000-client sizing recommendation.

Use a separate Compose project for the headless experiment to preserve any existing rendered state. Stop any other swarm publishing port 6080 first.

```sh
export OPENROUTER_API_KEY='your-openrouter-api-key'
docker compose -p swarm-headless up --build -d swarm
docker compose -p swarm-headless logs -f swarm
```

The first build installs dependencies, prepares the pinned world, and runs offline checks. The API key is supplied at runtime, never during the image build. The default `experiments/headless-m1.json` starts paid inference after preparation: ten agents, normal 400 ms ticks, 30 minutes of wall time, four concurrent requests, and a $5 ledger cap. See the [inference accounting limits](milestone-1.md#configure-inference).

Open [the 3D spectator](http://localhost:6080/watch/) to follow players and inspect their SDK state; the [2D map](http://localhost:6080/mapview/) remains available. For a remote server, use `ssh -L 6080:127.0.0.1:6080 user@concepcion` from your laptop. The image bundles pinned RS World assets using the engine cache. The inspector uses authenticated read-only gateway queries and never logs in as the character. It shows SDK observations, not an exact rendered client screen. See [headless calibration and limitations](../HEADLESS.md).

A changed experiment requires a new `SWARM_RUN_NAME`, which retains the same saved world and creates a separate run with its own deadline and budget. Existing characters are reused and newly requested agent IDs are added. See [growing to 25 agents](../HEADLESS.md#grow-the-existing-world-to-25-agents). Use a new Compose project only when you want an independent world. Only one project can publish host port 6080 at a time. If you deliberately want to delete this project's saved world and characters:

```sh
docker compose -p swarm-headless down --volumes
docker compose -p swarm-headless up -d swarm
```

This deletes saved characters, browser profiles if present, and the active-run pointer. Host-mounted `runs/` and `.local/hiscores/` remain. Removing only the run pointer is insufficient to reset progressed characters. Each new experiment has a new deadline and spending cap.

## Status, stopping, and resume

Look for `[run] RUN_ID` in the logs. Evidence is written to `runs/RUN_ID/`, including `report.json`, `manifest.json`, `state.sqlite`, and `agents/m1/AGENT_ID/events.jsonl`.

```sh
docker compose -p swarm-headless exec --user node swarm npm run swarm -- world stats
docker compose -p swarm-headless exec --user node swarm npm run swarm -- status --run RUN_ID
docker compose -p swarm-headless exec --user node swarm npm run swarm -- memory get --run RUN_ID --agent agent1
docker compose -p swarm-headless stop swarm
docker compose -p swarm-headless up -d swarm
```

Stopping drains the harness, stops clients, then saves/stops the world. Compose allows four minutes for cleanup. Restart selects the durable active-run pointer and retains its original deadline, memory, and spending ledger. Downtime counts against the duration. If the deadline has passed, the viewer opens without new inference. Changed configuration under the same run name, or a corrupt/missing referenced run, fails instead of resetting the budget. Keep `SWARM_RUN_NAME` and `SWARM_EXPERIMENT` set when restarting a named run. An exclusive filesystem lock rejects simultaneous containers using the same state volume.

The viewer and world remain available after the harness ends. Ctrl-C in `logs -f` only leaves the log viewer. Ordinary `down` retains the volume. An abrupt host shutdown can still interrupt pending actions and writes; inspect evidence before resuming.

## View without inference

```sh
docker compose -p swarm-headless down
docker compose -p swarm-headless run --rm --service-ports swarm --view-only
```

No API key is required. The world and clients start, but preparation, inference, and recording do not. Ctrl-C shuts down the foreground container. For a persistent preview with ordinary Compose logs, stop the foreground container and run `docker compose -p swarm-headless -f compose.yaml -f compose.preview.yaml up -d swarm`. See [updating concepcion](../HEADLESS.md#update-the-existing-preview-on-concepcion) for preserving the existing deployment.

## Optional rendered clients

Use the existing browser preset with its own state volume:

```sh
export SWARM_EXPERIMENT=experiments/openrouter-m1.json
docker compose -p swarm-browser up --build -d swarm
```

Open [the live desktop](http://localhost:6080/vnc.html?autoconnect=true&resize=scale). This mode starts Chromium tabs, Xvfb, noVNC, and FFmpeg. Recording captures the visible desktop at 10 fps and cycles the focused tab every 30 seconds. Manual tab changes affect the recording; login URLs can appear. Videos are in `runs/RUN_ID/recordings/recording-UUID/session.mp4`, with a timeline beside them. A recording failure leaves agents running within their original budget/deadline but marks the run incomplete.

Use the same project name and `SWARM_EXPERIMENT` value for subsequent commands. Unset `SWARM_EXPERIMENT` to return to the headless default. Never switch presets against an existing experiment's state volume.

## Persistence and configuration

| Data | Location |
|---|---|
| World, player saves, client metadata, active-run pointer | Project's `swarm-state` volume |
| Name pool and unique-name allocations | Host `.local/hiscores/` |
| Traces, SQLite ledger, reports, optional videos | Host `runs/` |
| Agent modules, prompts, profiles | Host `agents/`, mounted read-only |
| Experiment configuration | Host `experiments/`, mounted read-only |

For a custom experiment set `SWARM_EXPERIMENT=experiments/YOUR_FILE.json`. The image currently contains only world `m1`; retain that world ID. Native operation also uses fixed ports. Multi-world orchestration is deferred.

Prompt/profile edits apply at task boundaries. Agent module edits require a harness restart; runtime changes require rebuilding the image. Resume requires identical experiment configuration. Credentials, local worlds, names, and recordings are excluded from the image build. Data ownership inside the container is UID/GID 1000.

Only `127.0.0.1:6080` is published; game login, SDK gateway, management, and Chromium-control ports stay inside the container. The headless proxy exposes approved read-only spectator/cache routes and observations for managed agents. Browser mode runs Chromium with its sandbox disabled inside the container and is intended for the local game desktop.

## Verification limit

Offline lifecycle, configuration, trace, and route checks run locally and during image builds. Docker image execution, live Linux/Bun clients, accelerated behavior, and server capacity have not been validated in the coding sandbox. Inspect `docker compose -p swarm-headless logs swarm` and `/app/.local/worlds/m1/engine.log` or `lite-AGENT_ID.log` inside the container if startup fails. Follow the staged [server calibration](../HEADLESS.md#calibration-on-concepcion) before expanding population or speed.
