# Run the swarm in Docker

The container runs the game server, SDK gateway, Pi agent harness, ten rendered Chromium clients, and FFmpeg recorder. You view and interact with those clients through your own browser. No host Node, Bun, Chromium, or FFmpeg installation is required.

The paid preset now uses the [RuneBench SDK baseline](runebench-baseline.md), with one Bun code executor per character and searchable local SDK/wiki references. For these early tests, start each experiment with a fresh world and characters using the procedure below.

## Start the 30-minute test

In Docker Desktop, open **Settings → Resources / VM resources → Advanced** and allocate **at least 32 GiB of memory to the Docker VM**; 40 GiB leaves headroom if the Mac has enough physical RAM. Apply the change and let Docker restart before launching the swarm. Compose allows up to 32 GiB total container memory and 16 GiB of shared memory for Chromium. Shared memory counts toward the total; these are usage limits, not preallocated memory. CPU use is uncapped within the CPUs assigned to Docker Desktop. A Compose limit cannot enlarge the VM's allocation. See [Docker Desktop resource settings](https://docs.docker.com/desktop/settings-and-maintenance/settings/#advanced).

Then run this from the implementation checkout:

```sh
cd /Users/stuart/Developer/CasaDilauro/projects/osrs-bot-swarm/.worktrees/typescript-poc
read -rs 'OPENROUTER_API_KEY?OpenRouter API key: '
export OPENROUTER_API_KEY
docker compose down --volumes
docker compose up --build -d swarm
docker compose logs -f swarm
```

Skip the hidden key prompt if the environment already supplies it. The first image build installs dependencies, prepares the pinned game world, and runs the tests; allow several minutes. The key is supplied only at container runtime, never during the image build.

Use the same `down --volumes` then `up --build -d swarm` sequence for each fresh test. This deletes this Compose project's saved world, characters, browser profiles, and active-run pointer. Host-mounted `runs/` traces/videos and `.local/hiscores/` names remain. Each test gets empty agent memory, a new 30-minute clock, and its own $5 cap. Removing only the run pointer is insufficient: progressed characters can fail the initial skills/equipment/inventory equality check.

Open **[the live desktop](http://localhost:6080/vnc.html?autoconnect=true&resize=scale)** in your normal browser. You will see Chromium inside the container with ten game tabs. You can click tabs and interact with them yourself. These are the existing bot sessions, so viewing does not create duplicate logins. The recorder focuses another tab every 30 seconds and will therefore also change the tab visible on the desktop.

Docker recording uses FFmpeg's X11 desktop capture at 10 fps, independently of the game's JavaScript. It records the visible desktop, including browser controls and any manual tab changes; local game login URLs may be visible. The agent label and timeline describe the recorder's scheduled tab switches, so avoid manually switching tabs when you want that schedule to match the video. Switch times are approximate wall-clock offsets from encoder launch. A capture/encoder failure is logged and marks the recording failed, but agents continue under the original deadline and spending cap. A run missing its requested video is still reported as incomplete.

After all characters finish preparation, the experiment runs for 30 minutes with four concurrent model requests and the existing $5 ledger cap. The initial characters use names from your collected pool, randomized appearances, and password `admin`. This is a new container world, separate from the native Mac `m1` and `m1smoke` worlds. Native server ports do not conflict because only the desktop port is published by Docker.

Look for `[run] RUN_ID` in the logs. Videos and traces are written directly to the project:

```text
runs/RUN_ID/recordings/recording-UUID/session.mp4
runs/RUN_ID/recordings/recording-UUID/timeline.jsonl
runs/RUN_ID/agents/m1/AGENT_ID/events.jsonl
```

The desktop and game remain available after the harness finishes. Ctrl-C in `docker compose logs -f` only leaves the log viewer.

## Status and stopping

```sh
docker compose exec --user node swarm npm run swarm -- status --run RUN_ID
docker compose exec --user node swarm npm run swarm -- memory get --run RUN_ID --agent agent1
docker compose stop swarm
```

Stopping signals the harness to drain and finish its MP4 before closing Chromium and the world. Compose allows up to four minutes for cleanup. An abrupt Docker/host shutdown can still leave the final video fragment incomplete; previously written video fragments, SQLite state, and traces remain on disk.

Restart with `docker compose up -d swarm`. The durable active-run pointer selects the same experiment run, retaining its original deadline, memory, and spending ledger; downtime counts against the 30 minutes. If that deadline has passed, startup opens the desktop without starting more inference. A corrupt or missing referenced run fails rather than silently resetting the budget. This wrapper operates one durable experiment; it does not reset characters or start additional experiments on restart. An exclusive filesystem lock rejects a second container using the same state volume.

To apply a changed memory configuration, first stop the swarm, adjust Docker Desktop's VM resources if necessary, and run `docker compose up -d --force-recreate swarm`. No image rebuild is needed. Check actual container usage with `docker stats --no-stream typescript-poc-swarm-1`, and shared-memory usage with `docker compose exec swarm df -h /dev/shm`. A renderer crash can also have causes other than memory; increasing limits is not proof that its cause has been fixed.

## View without inference

To check desktop and client startup without an API key or model spending:

```sh
docker compose down
docker compose run --rm --service-ports swarm --view-only
```

The game and ten clients start; the harness and recording do not. Character preparation is performed when the normal experiment starts. Ctrl-C shuts down this foreground container.

## Persistence and editing

| Data                                                               | Location                                                |
| ------------------------------------------------------------------ | ------------------------------------------------------- |
| Game database, player saves, browser profiles, current run pointer | Compose volume `swarm-state`                            |
| Name pool and unique-name allocations                              | Host `.local/hiscores/`                                 |
| Video, traces, SQLite experiment state, reports                    | Host `runs/`                                            |
| Agent modules, prompts, profiles                                   | Host `agents/`, mounted read-only in the container      |
| Experiment configuration                                           | Host `experiments/`, mounted read-only in the container |

Ordinary `docker compose down` retains the state volume. Use `down --volumes` for the fresh early-test workflow above; omit `--volumes` only when deliberately preserving a run for resume. The container bootstrap assigns ownership of its data directories and name database to its runtime user; on Linux these files use UID/GID 1000.

Prompt/profile edits apply through the existing hot-reload path. Agent module changes need a harness restart; source/runtime changes require an image rebuild. Resume requires the same experiment configuration. The image uses the reviewed npm lock and pinned public RS-SDK Git revision; host `.git`, `.env`, worlds, names, and recordings are excluded from its build context.

The [official Node image](https://hub.docker.com/_/node) and [official Bun image](https://bun.sh/guides/ecosystem/docker) supply the runtimes. noVNC provides the [browser desktop client](https://github.com/novnc/noVNC/blob/master/docs/EMBEDDING.md). Only `127.0.0.1:6080` is published; game, gateway, VNC, and Chromium-control ports remain inside the container. Chromium runs as the `node` user with its sandbox disabled inside this container; it is intended for the local game desktop.

## Verification limit

State preservation/restart selection, browser flags, startup cancellation, Compose configuration, shell syntax, and the existing offline suite are checked locally. The image also runs `npm run check` during its build. **Docker image build, Linux Chromium/noVNC startup, and the full recorded test have not been verified in the coding sandbox: access to the Docker daemon is denied.** If startup fails, inspect `docker compose logs swarm`; engine details are in `/app/.local/worlds/m1/engine.log` inside the container.
