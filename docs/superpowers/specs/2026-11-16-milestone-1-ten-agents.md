# Milestone 1: ten editable, observable agents

> Superseded execution limits (2026-11-17): per user direction, script/code/output/context/memory and per-task caps were removed. Conversations now persist across tasks and restarts. See [current behavior](../../runebench-baseline.md#context-and-execution). The original design below is retained as history.

> Superseded by [the TypeScript POC specification](2026-11-16-typescript-poc.md). The user chose TypeScript for the POC after clarifying code-level observation/context customization; this Python-first document is historical.

This is the self-contained milestone-1 specification distilled from the conversation. The user develops in Python and does not write TypeScript: Python is therefore the research and agent-development surface. This supersedes the earlier Pi-first/TypeScript harness decision and the Lumbridge-specific assumptions in `references/lumbridge-ai/docs/plans/2026-11-16-agent-economy-milestones.md`. Numerical defaults below are proposed engineering choices, not experimental findings.

## Outcome

Run ten independent Python agents in one private local RuneScape world, visible in ten rendered browser tabs. Each agent has editable instructions, private durable tableau memory, a common character-scoped toolset, and bounded task conversations. An operator can inspect the exact effective model context and tool outcomes in files, capture the live view, change a profile, and restart the harness without losing memory or replaying uncertain actions.

This milestone establishes a development environment and a 30-minute live demonstration. It does not establish economically optimal behavior. Profitable play, systematic visual diagnosis, prompt studies, headless execution, and population scaling follow later.

## Foundation and repository ownership

- Use upstream `MaxBittker/rs-sdk`, pinned initially to `3aa493c3d26680df5bae2b475cc1805e3db05ae3`, as a dependency at `vendor/rs-sdk` via a Git submodule. Its SDK contains public/private chat, trade, basic gameplay, screenshots, and cancellation support. Verify this pin locally before implementing against it.
- Leave `references/lumbridge-ai` untouched. At planning time it is a nested repository and the parent has no `.gitmodules` or tracked files; do not silently register, absorb, delete, or commit that reference repository.
- Implement the Python harness in `src/swarm/` and the game adapter in `bridge/`, not inside either upstream or references. A separate upstream contribution is appropriate only if a demonstrated SDK gap requires it.
- Harness: Python 3.12+, asyncio, sqlite3, uv, Pydantic 2, httpx, pytest. The small game bridge uses Node.js 24, TypeScript/tsx and Puppeteer 24; engine/gateway/client build use Bun minimum `1.3.14` and upstream frozen lockfiles. Python-facing commands and examples must not require the researcher to edit TypeScript.
- Use a small explicit Python request/tool loop and a model adapter, initially the OpenAI-compatible chat-completions protocol with a user-supplied endpoint/model. Python owns context construction, memory, prompts, scheduling, tools, limits, and trace recording. No Pi dependency is required. Slick may supply a later model/session adapter after verifying fresh per-request context and usage reporting; do not couple the milestone to a dirty sibling checkout. The existing Python channel runtime is optional transport for later scale, not a requirement for ten asyncio agents.

## Runtime defaults and boundaries

- Exactly ten agents in the checked-in demonstration; permit 1–10 for local development. No default model, credentials, inference endpoint, or dollar budget. Those are explicit operator inputs before live inference.
- Demonstration duration: `1800` seconds after every character is ready. World tick: `400` ms. XP multiplier: `1`. Record effective settings; never assume an environment variable was applied.
- Global inference concurrency: `4`; one outstanding request/task and one mutating action program per agent. Inference slots cover the full request and release only after completion or confirmed shutdown on error/cancellation, not after the HTTP connection opens. Start with non-streaming responses; streaming is optional later.
- Fresh observations: at most `3000` ms old at request dispatch and tool dispatch. Stale/disconnected agents stop dispatching and wait for fresh state. Preparation timeout `300` seconds; a failed readiness barrier does not start the experiment clock.
- Each task: maximum `8` model requests, `16` tool calls, `120` seconds, with `2048` maximum output tokens per request. One named game activity lasts at most `30` seconds. Activity/strategy loops are Python functions; the bridge executes individual SDK operations. Every fresh task starts with an empty task transcript plus the live tableau and saved memory. Historical transcripts remain on disk.
- Request admission uses a FIFO global queue, bounded by the agent count. No automatic provider retry in milestone 1. Erroring agents wait `5000` ms before another task, preventing failure storms. Healthy completed tasks wait `1000` ms before another; running bounded activities do not require new inference.
- Read-only tools are scoped too. No shell, filesystem, arbitrary JavaScript, arbitrary SDK method, cross-agent memory, or administrative world-state tools are exposed to the model.
- Game endpoints are explicitly local loopback URLs. Never fall back to the upstream public service. Ten browser tabs are the actual clients; closing one is reported as loss of observation, not silently repaired by opening a competing login.

## Developer configuration and memory

`experiments/m1.json` identifies the world, model configuration, limits, and ten agent entries. Agent entries point to `agents/<id>/profile.json` and `agents/<id>/instructions.md`. Profiles contain role, objective, and registered context policy name (`tableau` initially). Instruction/profile edits take effect only between tasks, after validation, with a content hash in the trace. An invalid edit keeps the last valid revision and emits an error.

Each character's immutable experiment objective and role are separate from its writable memory. Writable memory is `{ plan: string[], beliefs: string[], relationships: Record<string,string>, nextAction: string }`, with a maximum total serialized UTF-8 size of `16384` bytes. Tools read/replace it with an expected revision; reject conflicting writes, unknown fields, and attempts to modify authoritative fields. Operator edits use the same revision-checked persistence method.

An observation carries `runId`, `worldId`, `agentId`, `sessionEpoch`, monotonic `observationSeq`, `observedAt`, state age, and the SDK state. Label the SDK tick `clientTick`; it is not assumed to be the world's authoritative clock. Last-known bank contents and other unavailable fields retain their last-observed timestamp, or are explicitly unknown. Do not report unknown bank coins as zero.

Use one harness SQLite database per run, keyed by run/world/agent, with transactional memory revisions, action intents/outcomes, usage reservations, and trace events. The game server remains authoritative over inventory and money. Game credentials stay in ignored local files with restrictive permissions; never in context snapshots, traces, or committed examples.

## Request composition and traces

At the Python provider boundary, after obtaining an inference slot, refresh state and memory. Build one system instruction block from the profile and fixed rules, then one user-data message containing the live tableau, then the current task's valid message/tool-result sequence. Untrusted chat stays in this data block and is explicitly labeled as observations, not instructions. Do not include another agent's private messages or memories, or an omniscient operator map.

Construct this on a copy for each provider request. Do not mutate the durable task transcript, accumulate old live-state blocks, or break tool-call/result associations. Apply a `65536`-byte serialized task-context ceiling: end the task at a complete tool boundary before another request would exceed it; never truncate half an exchange. This is a byte limit, not a claimed token count.

Log the exact JSON request body and non-secret inference options sent by the Python model adapter, together with model, tool schemas, profile/policy/memory revisions, observation identity, and request id. Authentication headers are excluded. Later model adapters must preserve this same inspectable-request contract. Log complete final responses, usage, tool calls/results, and memory changes; partial-token logging is unnecessary. Structured outcomes distinguish `completed`, `dispatched`, `failed`, and `uncertain`.

Export append-only per-agent JSONL plus request JSON files. SQLite event ids make exports resumable after a crash. No silent truncation or overwrite of previous runs. Logging failure prevents new inference/tool effects and marks the run incomplete. Ignore secrets in provider errors and URLs. Cap the run's harness artifacts at `1` GiB initially; exceeding it fails visibly rather than deleting earlier evidence.

Use explicit per-million-token pricing from operator configuration to estimate monetary spending; record that these are estimates. Reserve a conservative per-request upper bound using the model context window and output cap, settle against returned usage, and enforce the cap across concurrent requests. Unknown usage keeps its reservation charged until reconciled. For paid providers, missing pricing is a startup error. A zero-priced local provider must be explicitly declared. Provider-side billing limits remain necessary for a hard dollar guarantee.

## Tool surface and effect semantics

Expose named tools: `get_state`, `read_memory`, `update_memory`, `search_events`, `say`, `dm`, `follow`, `stop_follow`, `trade_request`, `trade_offer`, `trade_accept`, `trade_decline`, `pickup`, `drop`, `walk`, `interact_npc`, `interact_loc`, `choose_dialog`, `close_interface`, `bank_open`, `bank_deposit`, `bank_withdraw`, `shop_open`, `shop_buy`, `shop_sell`, `equip`, `unequip`, `eat`, `attack`, and `gather`.

Use existing high-level BotActions where available. `gather` is a bounded loop for `chop`, `mine`, or `fish` using visible targets and stopping on capacity, failure, cancellation, or deadline. Selection is exact by observation-bound entity/item id or an unambiguous name; ambiguity returns candidates rather than silently selecting a different target. Do not let a slot/index from an old observation refer to a new entity/item.

Following uses the SDK's player interaction follow option; stopping follows by walking to the character's current tile and observing cessation. Verify the actual option mapping at the pinned revision. DM dispatch does not prove delivery. Low-level interactions report dispatch until an effect is observed; a successful Promise alone never means successful gameplay.

For direct trading, persist the approved partner and offers before accepting; recheck at both screens, refusing changed offers. A closed trade window alone is insufficient to call the trade settled. Test settled inventory deltas on both characters. Never automatically replay an uncertain trade/drop/purchase after a timeout or restart. Reconcile fresh state, then report uncertainty to the next task. Uncertainty cannot always be resolved uniquely from inventory alone.

## Python-to-game bridge

One Node subprocess owned by the Python harness hosts the ten scoped SDK connections. Communication is versioned newline-delimited JSON over stdin/stdout; stdout carries protocol frames only and stderr carries logs. Python owns model credentials and memory; the bridge receives only game credentials from ignored local files. It exposes a fixed SDK operation allowlist, observations, cancellation, and captures, not general JavaScript execution.

Each request has a unique id, agent id, method, parameters, and relative timeout. Responses match that id. Python supplies agent identity from the bound tool, never from model arguments. Validate messages and the same allowed operation set on both sides. A separate reader dispatches replies so a slow action does not block other agents. Cancellation uses an explicit cancel frame and the SDK AbortSignal; report whether completion is confirmed or effects remain uncertain. A pipe disconnect never triggers automatic resubmission. Pending financial/item actions are journaled before sending and retained as uncertain after a bridge/harness crash. Duplicate request ids must not execute twice in one bridge lifetime; across restarts, Python's journal prevents automatic replay rather than pretending to offer exactly-once game effects.

The bridge has no strategy, prompt, model loop, or durable research memory. Adding a new combination of existing operations, a role, a memory policy, or an evolutionary treatment must be Python-only work. New underlying game capabilities can require a small bridge/upstream change.

## Local world and rendered sessions

Use a dedicated disposable local world checkout at `.local/worlds/<worldId>/game` from the pinned upstream source, with its own database/player saves and loopback ports. This keeps generated state out of `vendor/rs-sdk` and the reference repo. New world creation never deletes or overwrites an existing world. Resume explicitly reuses it. Only one active harness owns a run/world at a time.

Install/build using upstream's documented setup, migrations, and lockfiles. Launch engine with login/friend/logger services, gateway, and built webclient. Record child PIDs and readiness. Stop only owned child processes and allow game saves to drain; a forced exit is marked incomplete. World startup is a local development command, not a production deployment system.

Generate ten new local character names from a short run prefix plus ordinal (alphanumeric, maximum 12 characters); persist credentials separately. Use upstream registration/first-login behavior, skip tutorial once, and verify comparable starting skills/equipment/coins. If that fails, abort preparation rather than deleting old accounts or starting a biased run. Fixture transfers for the tool smoke test occur in a separate disposable world, not in the scored demonstration.

Launch one visible Chromium instance with ten tabs using Puppeteer, each logged into its own character. Persist browser ownership separately from the harness loop so restarting the harness does not create duplicate tabs. A local-only operator command lists/focuses tabs and captures a screenshot. On action failure, make one best-effort screenshot with its observation/action id; screenshot failure must not mask the original error. Screenshots are linked evidence, not an exact snapshot of the instant an action occurred. Video and post-hoc world replay are deferred to milestone 2/headless planning.

## Acceptance

1. Offline tests exercise independent memory, live-state replacement on every request including tool follow-ups, tool isolation, concurrency/budgets, trace recovery, and no blind action replay.
2. A local three-character smoke test verifies public chat, DM recipient isolation, follow/stop, trade, drop/pickup, and a short gathering/banking/shop path without paid inference. Three characters are needed to prove a bystander does not receive the DM.
3. A live ten-agent, 30-minute run uses an explicit model and budget. Every agent completes at least one fresh model/tool cycle, records a memory update, and attempts its individual economic objective. A completed profitable economic loop is reported as observed behavior, not guaranteed by the harness.
4. During the run, edit one profile and verify next-task application; restart the harness while keeping game/browser alive and verify memory continuity and no duplicate transfer; close one tab and verify visible stale/offline status. Preserve intervention times and mark this as a development run, not a clean economic study.
5. Produce `acceptance.json` and a short report naming model/config/pins, runtime, per-agent status/usage/actions, trace completeness, screenshots, failures, and which live checks actually passed. Missing credentials/budget or skipped live tests leave the milestone explicitly incomplete.

## Deferred

No Pi dependency, required ZeroMQ/Infinity integration, Lumbridge dashboard port, new panels, automatic video, headless sessions, packet replay, RLM recursion, wiki memory, 100-agent pooling, evolution, taxes, authoritative research economy ledger, or unsupported capacity claims. Preserve extension points only where required by interchangeable context policy and provider configuration.

## Evidence

- [Upstream RS-SDK pin](https://github.com/MaxBittker/rs-sdk/tree/3aa493c3d26680df5bae2b475cc1805e3db05ae3), especially `sdk/index.ts`, `sdk/actions.ts`, `sdk/execution-context.ts`, and `server/engine/src/util/WorldConfig.ts`.
- Local Slick inspection: `/Users/stuart/Developer/AI/slick/slick/session.py` exposes `Session.acall(context)` for explicit fresh input, and `providers/base.py` defines stateless calls and continuation-based turns. The checkout contains uncommitted work; no Slick API/dependency change is required here.
- `../agent-runtime` provides optional multiplexed transport; it does not yet supply this agent context/tool loop.
- Lumbridge reference commit `210b7ac9020bc1ed07fa97c27a8624317536b56b`: use as examples, not a runtime dependency.
