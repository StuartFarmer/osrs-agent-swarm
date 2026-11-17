# Ten-agent TypeScript POC

> Superseded execution limits (2026-11-17): per user direction, script/code/output/context/memory and per-task caps were removed. Conversations now persist across tasks and restarts. See [current behavior](../../runebench-baseline.md#context-and-execution). The original design below is retained as history.

Current decision: use TypeScript for the POC, with Pi and direct upstream RS-SDK integration. This supersedes the Python-first milestone specification and plan. The important customization requirement remains: agent implementations control observation selection/transformation and context construction; the shared runtime controls waking and execution. JSON/Markdown profiles are optional inputs, not the customization boundary.

## Scope

Demonstrate ten agents in a private local world with ten rendered clients, independent durable memory, editable agent modules, a shared toolset and execution loop, and simple per-agent traces/screenshots. The operator can inspect model inputs, tool outcomes, and memory changes. Headless execution, richer visual replay, dashboard work, evolutionary studies, and scaling are later milestones.

## Ownership

- Runtime: global wake policy, inference concurrency, provider credentials, task budgets, tool execution, authoritative state acquisition, persistence, tracing, cancellation, and recovery.
- Agent module: `observe()` selects/transforms the character's available observations; `buildContext()` constructs each request from those observations, scoped memory/history, and the current bounded task transcript.
- Game: authoritative inventories, currency, positions and other game facts. Agent beliefs cannot overwrite them.
- Operator: agent code, prompts, permissions, experiment configuration and objectives. Agent modules are trusted operator code, not model-generated programs or a sandbox.

Context is rebuilt before every model request, including follow-ups. Collect current state after waiting for inference admission. Agent modules can retrieve selected private memories/history and implement markedly different context policies without editing the shared loop. Observation policy also governs state-reading tools, unsolicited event/chat delivery, and information inside tool results; filtering the prompt alone is insufficient. Report unavoidable action success/failure without leaking hidden raw state. Screenshots and full raw diagnostics are operator-only unless explicitly included in a treatment.

An implementation may narrow observations; it must not grant omniscient or cross-agent data unavailable to the character. The first POC offers selected complete observation domains (inventory, position, chat, nearby entities, interfaces, bank/shop) plus derived facts. General field-level security labels and information-flow enforcement are out of scope, but excluded domains must not reappear through read tools or raw result payloads.

## Foundation and limits

- Root harness uses Node.js 24, TypeScript/tsx, Pi agent-core/pi-ai 0.84.2, TypeBox 1.3.7, native node:test/node:sqlite, and Puppeteer 24. Engine/gateway/client build use Bun >=1.3.14.
- Upstream RS-SDK submodule at `vendor/rs-sdk`, pinned to `3aa493c3d26680df5bae2b475cc1805e3db05ae3`. `references/lumbridge-ai` remains untouched reference material.
- Demo: exactly 10 agents; development supports 1–10. Run 1800 seconds after all agents are ready. Preparation timeout 300 seconds. World tick 400 ms; XP rate 1; verify actual settings.
- Global inference concurrency 4 across full provider streams. Per task: at most 8 model requests, 16 tools, 120 seconds; output limit 2048 tokens/request. Named activities max 30 seconds. One mutating program per character.
- Observation freshness <=3000 ms at model dispatch and game dispatch. Revalidate target identity before actions. Client tick is not asserted to be authoritative server time.
- Task context ceiling 65536 serialized UTF-8 bytes; memory ceiling 16384 bytes. Stop at valid tool-exchange boundaries instead of truncating call/result pairs. Artifact quota initially 1 GiB.
- Healthy task delay 1000 ms, failure delay 5000 ms, FIFO inference admission. No automatic provider retries. Provider/model/endpoint/key/prices/spend cap are explicit operator inputs, not defaults.
- Resume retains deadline, spending and memory. Unknown request usage keeps a conservative reservation. Uncertain game effects are not automatically repeated. Cost accounting is estimated from declared tariffs; a hard billing ceiling requires provider controls.

## Memory, tools and artifacts

Private SQLite memory is revisioned and agent-editable: plan, beliefs, relationships, next action. Runtime-owned fields are read-only. Private history can be searched through an agent-scoped interface. Profile/code revisions are recorded per task. Operator changes take effect only between tasks; validate a new module before replacing the last valid one. Do not accumulate imported module versions indefinitely: a documented harness restart is acceptable for code edits; instructions/profile reloads can be automatic.

Shared tools cover public/private chat, follow/stop, trade request/offer/accept/decline, pickup/drop, movement, NPC/object interaction, dialogs, banking, shops, equipment, food, combat and bounded gathering. Use upstream methods; there is no need to reimplement DMs. No arbitrary JavaScript, filesystem, shell or unrestricted SDK dispatch tool. Low-level dispatch is not success proof. Changed trade offers/partners require refusal; timeout after dispatch is uncertain, not an automatic retry.

Trace effective Pi Context and tool schemas/options before provider dispatch; exclude credentials. Record complete final responses, usage, action intent/outcome, observation and memory revisions, and task/request/action ids. Operator logs may contain raw character state, but agent-accessible history must obey observation policy. SQLite event ids support recoverable per-agent JSONL/request-file exports. Disk failure stops new unrecorded work. Best-effort screenshots on errors or operator request supplement logs; no continuous video or retrospective visual reconstruction promise.

## Local development and acceptance

Private disposable world checkout and saves live in `.local/worlds/<id>/game`; no implicit resets or public endpoints. Browser and world processes are separately owned so the harness can restart without reopening ten clients. Credentials stay in ignored local files. Start accounts with comparable skills/equipment/coins after tutorial skip. Closing a tab is visible as stale/offline status.

Pass offline tests, then a three-character local smoke for public chat, DM recipient isolation, follow/stop, two-sided trade and pickup/drop. Run ten agents for 30 minutes with real configured inference; each completes a model/tool cycle and memory update. Demonstrate two context implementations using the same execution loop, with a test proving an excluded observation domain cannot leak through tools/history. Edit instructions, restart the harness, and close/restore a tab while recording interventions. Preserve actual contexts and a screenshot. Report observed economic behavior; do not claim profitable play or completion from mock tests alone.

## Future Python boundary

Keep game access behind ordinary typed interfaces using JSON-compatible arguments/results, separate from Pi and agent modules. A future Python harness could call that interface through a bridge while retaining tools, traces and experiment semantics. Do not implement that bridge now. Migration is a port plus transport/cancellation work, not an automatic language switch.

## Sources

- [Pinned RS-SDK](https://github.com/MaxBittker/rs-sdk/tree/3aa493c3d26680df5bae2b475cc1805e3db05ae3): SDK actions, DM, cancellation and rendered clients.
- [Pi 0.84.2 interfaces](https://github.com/earendil-works/pi/blob/v0.84.2/packages/agent/src/types.ts): async StreamFn permits admission and request construction at the actual provider boundary.
- Earlier inspected Lumbridge implementation is an example only; do not port its dashboard or cooperative fleet defaults as requirements.
