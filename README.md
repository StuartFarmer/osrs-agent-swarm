# RuneScape agent swarm

A TypeScript POC for RuneScape agents in a private local game world. The `./swarm` launcher uses 25 true headless clients; rendered clients remain available through the browser preset. The default experiment uses the RuneBench SDK baseline: agents execute TypeScript against the game SDK, search local SDK/wiki documentation, and keep private SQLite notes. One shared Pi loop owns scheduling, model concurrency, tools, and tracing.

**Status: headless migration on `feat/headless-swarm`; live headless acceptance, 8× speed, and 1,000-agent capacity have not been validated.** See [verification status](docs/reports/milestone-1.md) and the [runbook](docs/milestone-1.md).

## Run from the repository checkout

The headless implementation is on `feat/headless-swarm` in the ordinary checkout; no worktree is needed. Run all commands from the repository root—the directory containing `compose.yaml`, `Dockerfile`, and `package.json`.

You need Docker with Compose and an OpenRouter API key. In Docker Desktop, allocate at least **32 GiB of memory** to the Docker VM before starting. Docker installs Node, Bun, Chromium, FFmpeg, and the pinned RS-SDK; no host installation of those tools or submodule initialization is needed for this route.

From the repository root:

```sh
./swarm
```

The launcher prompts privately for an OpenRouter API key if it is not already exported, uses sudo when Docker needs it, builds the game and bundled 3D viewer, and starts the service. It reuses the `swarm-headless` saved world and the named `scale25` run. **25 agents, up to 25 concurrent model requests, 30 minutes, and a $5 ledger cap per run.** Existing character progress is retained. See [inference accounting limits](docs/milestone-1.md#configure-inference).

On your Mac, leave this SSH tunnel running:

```sh
ssh -N -L 16080:127.0.0.1:6080 user@concepcion
```

Open **http://localhost:16080/watch/** for the live 3D viewer and agent picker. The picker lists the saved roster; startup/inference status is in `./swarm logs`. The [2D map](http://localhost:16080/mapview/) remains available. If you run Docker on your own computer, open http://localhost:6080/watch/ directly.

**Docker builds and serves the viewer. Do not run the native cache-conversion or viewer-build commands on the server host.** No host Bun, Node, Yarn, or viewer checkout is needed.

```sh
./swarm logs     # Follow startup and inference logs.
./swarm stop     # Stop inference and save/stop the world.
./swarm preview  # Start the same world and viewer without inference.
./swarm         # Start/resume inference with the original deadline and ledger.
```

The viewer remains available when inference finishes. An expired run does not automatically restart its spending budget. Use a new explicit name, e.g. `SWARM_RUN_NAME=next-run ./swarm`, to start another run in the same saved world. A new run starts fresh agent conversations/private memory; previous traces remain in `runs/`. Override the preset with `SWARM_EXPERIMENT=experiments/YOUR_FILE.json`. Configuration must remain unchanged when resuming a run name.

Saved worlds live in the Compose volume; traces live in `runs/`. Never delete the volume to update the image or grow the population. To update an ordinary Git checkout, run `git pull --ff-only` then `./swarm`. Deployments initially copied without `.git` need the source update procedure in [HEADLESS.md](HEADLESS.md#update-the-existing-preview-on-concepcion).

## Code and configuration

- [Run the swarm in Docker](docs/container.md): headless launch, persistence, and optional rendered mode.
- [Headless operation](HEADLESS.md): native commands, server calibration, timing, tracing, and limitations.
- [One-command launcher](swarm): build, launch, logs, stop, and preview.
- [Docker entry point](docker/entrypoint.sh) and [launcher](docker/run.ts): start and stop the container's world, desktop, clients, and experiment.
- [CLI](src/cli.ts): operator commands, invoked as `npm run swarm -- …`.
- [RuneBench agent](agents/runebench.ts): the default agent used by the paid preset.
- [Agent profiles and prompts](agents/profiles/): per-agent configuration and instructions.
- [Gatherer](agents/gatherer.ts) and [merchant](agents/merchant.ts): alternative observation/context policies.
- [Shared runtime](src/runtime.ts): refreshes context after inference admission, including tool follow-ups.
- [25-agent experiment](experiments/headless-25.json): the launcher default; 25 concurrent requests, 400 ms ticks, 30 minutes, and $5 ledger cap.
- [Ten-agent smoke preset](experiments/headless-m1.json): the original four-request baseline used by bare Compose.
- [Rendered OpenRouter experiment](experiments/openrouter-m1.json): the browser/recording preset.
- [Unconfigured template](experiments/m1.json): model configuration is intentionally null.

## Native development

For development outside Docker, use Node 24, Bun >=1.3.14, Python 3.10+, and FFmpeg/ffprobe if recording rendered clients. Initialize the pinned SDK and install dependencies from the repository root:

```sh
git submodule update --init --recursive vendor/rs-sdk
npm ci
bun install --cwd vendor/rs-sdk --frozen-lockfile
```

See the [native runbook](docs/milestone-1.md) for world creation, client startup, optional verification, and recording commands. Local saves, credentials, traces, screenshots, videos, and collected names are ignored by Git and are not included in a fresh checkout.

The provider adapter supports OpenAI-compatible Chat Completions and explicit OpenRouter routing with price ceilings and disabled reasoning. Other APIs need an explicit adapter. Multiple-world orchestration, deterministic replay, dashboards, and evolution are deferred. The current launcher owns one world; upstream supports deploying additional worlds later.

See the [RuneBench baseline guide](docs/runebench-baseline.md) for the default tools and context policy. Existing tableau runs need that guide's separate-run procedure before switching configuration.
