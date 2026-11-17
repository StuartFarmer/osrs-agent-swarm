# RuneScape agent swarm

A TypeScript POC for RuneScape agents in a private local game world. The default launch uses ten true headless clients; rendered clients remain available through the browser preset. The default experiment uses the RuneBench SDK baseline: agents execute TypeScript against the game SDK, search local SDK/wiki documentation, and keep private SQLite notes. One shared Pi loop owns scheduling, model concurrency, tools, and tracing.

**Status: headless migration on `feat/headless-swarm`; live headless acceptance, 8× speed, and 1,000-agent capacity have not been validated.** See [verification status](docs/reports/milestone-1.md) and the [runbook](docs/milestone-1.md).

## Run from the repository checkout

The headless implementation is on `feat/headless-swarm` in the ordinary checkout; no worktree is needed. Run all commands from the repository root—the directory containing `compose.yaml`, `Dockerfile`, and `package.json`.

You need Docker with Compose and an OpenRouter API key. In Docker Desktop, allocate at least **32 GiB of memory** to the Docker VM before starting. Docker installs Node, Bun, Chromium, FFmpeg, and the pinned RS-SDK; no host installation of those tools or submodule initialization is needed for this route.

From the parent directory of your checkout:

```sh
cd osrs-bot-swarm
git switch feat/headless-swarm
export OPENROUTER_API_KEY='your-openrouter-api-key'
docker compose up --build -d swarm
docker compose logs -f swarm
```

The first build downloads dependencies, prepares the game world, and runs the image's checks. Keep the API key out of committed files. The configured experiment starts paid inference after all ten characters are ready: **30 minutes, four concurrent model requests, and a $5 ledger cap per run**. See [the inference runbook](docs/milestone-1.md#configure-inference) for accounting limits.

Open **[the 3D spectator](http://localhost:6080/watch/)** to follow characters and inspect their published game state. The [2D map](http://localhost:6080/mapview/) is also available. The headless container starts the server, lite clients, and harness without Chromium, Xvfb, or recording. Traces and reports are written to `runs/`; saved worlds and client metadata live in the Compose `swarm-state` volume. The image still includes browser dependencies for the optional rendered preset. See [headless operation and calibration](HEADLESS.md), including [25 agents in the existing world](HEADLESS.md#grow-the-existing-world-to-25-agents). Name collection is optional: a fresh checkout uses synthetic names unless you supply a collected pool.

```sh
docker compose stop swarm  # Stop the harness, clients, and world.
docker compose up -d swarm # Resume the same run with its original deadline and budget.
```

If the deadline has passed, restarting opens the viewer without starting more inference. To start a **new experiment**, follow the [fresh-run procedure](docs/container.md#start-the-30-minute-test); it deletes the saved world and characters. Existing local data from another checkout is not moved by a Git merge, and Compose uses a separate project by default when the checkout directory name changes.

## Code and configuration

- [Run the swarm in Docker](docs/container.md): headless launch, persistence, and optional rendered mode.
- [Headless operation](HEADLESS.md): native commands, server calibration, timing, tracing, and limitations.
- [Docker entry point](docker/entrypoint.sh) and [launcher](docker/run.ts): start and stop the container's world, desktop, clients, and experiment.
- [CLI](src/cli.ts): operator commands, invoked as `npm run swarm -- …`.
- [RuneBench agent](agents/runebench.ts): the default agent used by the paid preset.
- [Agent profiles and prompts](agents/profiles/): per-agent configuration and instructions.
- [Gatherer](agents/gatherer.ts) and [merchant](agents/merchant.ts): alternative observation/context policies.
- [Shared runtime](src/runtime.ts): refreshes context after inference admission, including tool follow-ups.
- [Headless experiment](experiments/headless-m1.json): ten agents, 400 ms ticks, 30 minutes, four concurrent model requests, and $5 ledger cap.
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
