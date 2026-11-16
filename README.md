# RuneScape agent swarm

A TypeScript POC for ten rendered RuneScape agents. Each agent has private SQLite memory and programmable observation/context functions. One shared Pi loop owns scheduling, model concurrency, tools, and tracing.

**Status: POC implementation with preliminary offline coverage; live milestone acceptance has not passed.** See [verification status](docs/reports/milestone-1.md) and the [runbook](docs/milestone-1.md).

Start reading here:

- [Gatherer agent](agents/gatherer.ts): observation selection and context construction.
- [Merchant agent](agents/merchant.ts): a different policy using the same runtime.
- [Shared runtime](src/runtime.ts): refreshes context after inference admission, including tool follow-ups.
- [OpenRouter experiment](experiments/openrouter-m1.json): ten agents, DeepSeek Flash, and the authorized $5 ledger cap.
- [Unconfigured template](experiments/m1.json): model configuration is intentionally null.

The target environment is Node 24, Bun >=1.3.14, Pi 0.84.2, and the pinned upstream RS-SDK submodule. Python 3.10+ runs the resumable hiscores name collector; FFmpeg powers optional rotating game recordings (`run --record`). New characters receive randomized appearances. See the [runbook](docs/milestone-1.md) for collection and recording commands. Local saves, credentials, traces, screenshots, videos, and collected names are ignored by Git. The Lumbridge checkout remains reference material.

The provider adapter supports OpenAI-compatible Chat Completions and explicit OpenRouter routing with price ceilings and disabled reasoning. Other APIs need an explicit adapter. Python transport, headless clients, replay, dashboards, and evolution are later milestones.

Run the hiscores name collector in Docker with `docker compose up --build -d hiscores`, then follow progress with `docker compose logs -f hiscores`. Names and crawl checkpoints persist in `.local/hiscores/` on the host. See the [runbook](docs/milestone-1.md#collect-agent-names) for status, stop, and resume commands.
