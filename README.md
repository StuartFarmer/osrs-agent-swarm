# RuneScape agent swarm

A TypeScript POC for ten rendered RuneScape agents. Each agent has private SQLite memory and programmable observation/context functions. One shared Pi loop owns scheduling, model concurrency, tools, and tracing.

**Status: POC implementation with preliminary offline coverage; live milestone acceptance has not passed.** See [verification status](docs/reports/milestone-1.md) and the [runbook](docs/milestone-1.md).

Start reading here:

- [Run the swarm in Docker](docs/container.md): server, ten rendered agents, browser viewing, and recording.
- [Gatherer agent](agents/gatherer.ts): observation selection and context construction.
- [Merchant agent](agents/merchant.ts): a different policy using the same runtime.
- [Shared runtime](src/runtime.ts): refreshes context after inference admission, including tool follow-ups.
- [OpenRouter experiment](experiments/openrouter-m1.json): ten agents, DeepSeek Flash, and the authorized $5 ledger cap.
- [Unconfigured template](experiments/m1.json): model configuration is intentionally null.

The target environment is Node 24, Bun >=1.3.14, Pi 0.84.2, and the pinned upstream RS-SDK submodule. Python 3.10+ runs the resumable hiscores name collector; FFmpeg powers optional rotating game recordings (`run --record`). New characters receive randomized appearances. See the [runbook](docs/milestone-1.md) for collection and recording commands. Local saves, credentials, traces, screenshots, videos, and collected names are ignored by Git. The Lumbridge checkout remains reference material.

The provider adapter supports OpenAI-compatible Chat Completions and explicit OpenRouter routing with price ceilings and disabled reasoning. Other APIs need an explicit adapter. Python transport, headless clients, replay, dashboards, and evolution are later milestones.

With Docker Desktop running and `OPENROUTER_API_KEY` exported, run `docker compose up --build -d swarm`. Watch the agents at [localhost:6080](http://localhost:6080/vnc.html?autoconnect=true&resize=scale). The container runs the game, agent harness, Chromium clients, and FFmpeg recorder; videos and traces appear in `runs/`. See the [container guide](docs/container.md) for restart behavior and validation limits. Collect names with the Python script if needed; collection is independent of the swarm.

The paid preset now uses the [RuneBench SDK baseline](docs/runebench-baseline.md): TypeScript execution and searchable upstream wiki/docs, private notes, and no automatic full-world tableau. Existing tableau runs need the guide's separate-run procedure before restarting with the changed configuration.
