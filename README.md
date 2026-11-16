# RuneScape agent swarm

A TypeScript POC for ten rendered RuneScape agents. Each agent has private SQLite memory and programmable observation/context functions. One shared Pi loop owns scheduling, model concurrency, tools, and tracing.

**Status: offline implementation in progress; live milestone acceptance has not passed.** See [verification status](docs/reports/milestone-1.md) and the [runbook](docs/milestone-1.md).

Start reading here:

- [Gatherer agent](agents/gatherer.ts): observation selection and context construction.
- [Merchant agent](agents/merchant.ts): a different policy using the same runtime.
- [Shared runtime](src/runtime.ts): refreshes context after inference admission, including tool follow-ups.
- [Experiment](experiments/m1.json): ten agents and limits; model configuration is intentionally null.

The target environment is Node 24, Bun >=1.3.14, Pi 0.84.2, and the pinned upstream RS-SDK submodule. Local saves, credentials, traces, and screenshots are ignored by Git. The Lumbridge checkout remains reference material.

The initial provider adapter supports OpenAI-compatible Chat Completions with bounded output-token billing. Other APIs need an explicit adapter. Python transport, headless clients, replay, dashboards, and evolution are later milestones.
