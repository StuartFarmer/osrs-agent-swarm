# Milestone 1: Ten Python Agents Implementation Plan

> Superseded by [the TypeScript POC plan](2026-11-16-typescript-poc.md). Retained as a reference for a possible future Python port; do not execute this plan for the current POC.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a Python researcher ten visible RuneScape agents whose prompts, memory, context policies, tools, and strategies can be developed in Python.

**Architecture:** One asyncio Python harness owns independent tableaux, bounded task conversations, model calls, scheduling, and traces. A small Node subprocess exposes pinned upstream RS-SDK operations over versioned JSON lines; it has no agent/model logic. The game and rendered browser sessions are separate owned processes so restarting the harness preserves the world and characters.

**Tech Stack:** Python 3.12+, uv, asyncio/sqlite3, Pydantic 2, httpx, pytest; Node.js 24, TypeScript/tsx, Puppeteer 24 for the bridge; Bun >=1.3.14 for upstream RS-SDK.

**Spec:** [Milestone 1 specification](../specs/2026-11-16-milestone-1-ten-agents.md). This Python revision supersedes the earlier Pi/TypeScript harness plan following the user's language preference. No product code has been implemented.

## Global Constraints

- Python is the research and agent-development surface. The bridge has no strategy, prompt, model loop, or durable research memory.
- Exactly ten agents in the checked-in demonstration; permit 1–10 for local development.
- No default model, credentials, inference endpoint, or dollar budget. Those are explicit operator inputs before live inference.
- Demonstration duration: `1800` seconds after every character is ready. World tick: `400` ms. XP multiplier: `1`.
- Global inference concurrency: `4`; one outstanding request/task and one mutating action program per agent.
- Fresh observations: at most `3000` ms old at request dispatch and tool dispatch. Preparation timeout `300` seconds.
- Each task: maximum `8` model requests, `16` tool calls, `120` seconds, with `2048` maximum output tokens per request. One named game activity lasts at most `30` seconds.
- Writable memory maximum serialized UTF-8 size: `16384` bytes. Serialized task-context ceiling: `65536` bytes. Initial harness artifact quota: `1` GiB.
- Healthy task delay `1000` ms; failed task delay `5000` ms. No automatic provider retry in milestone 1.
- Upstream RS-SDK pin: `3aa493c3d26680df5bae2b475cc1805e3db05ae3`. Never silently update it or fall back to the public service.
- Leave `references/lumbridge-ai` untouched. Do not modify the sibling Slick or Python channel-runtime repositories.
- No arbitrary code/SDK dispatch tool, Pi dependency, dashboard port, headless execution, replay system, or evolution implementation in milestone 1.
- Commands run in `osrs-bot-swarm`; prefix shell commands with `rtk`. Commit only named paths, never `git add .`.

## Review Focus

- A bridge disconnect follows a sent trade: Tasks 2–4 and 7 preserve uncertainty and never retry it blindly.
- Cancellation races a reply: Task 3 correlates late replies and settles the action before allowing another mutation for that character.
- An entity index/slot changes during inference: Task 4 checks current identity, not merely the index's existence.
- A request waits for model capacity: Tasks 5–6 rebuild state after admission, including tool-result follow-ups.
- A memory/profile edit or disk failure occurs mid-task: Tasks 2, 6, and 7 enforce revision boundaries and stop unrecorded work.

---

## File structure and boundaries

The bridge is maintained infrastructure. Ordinary research changes edit Python modules, JSON profiles, and Markdown instructions. Python owns model-visible tool schemas; bridge schemas describe only underlying game operations.

| Files | Responsibility |
| --- | --- |
| `pyproject.toml`, `uv.lock`, `.gitignore`, `.gitmodules`, `vendor/rs-sdk` | Packaging and upstream pin |
| `src/swarm/config.py`, `src/swarm/types.py` | Strict experiment/profile/record contracts |
| `src/swarm/store.py`, `src/swarm/trace.py` | Durable memory/actions/usage/events and file exports |
| `src/swarm/bridge.py`, `bridge/protocol.ts`, `bridge/main.ts`, `bridge/game.ts` | Local RPC, cancellation, RS-SDK operations |
| `src/swarm/world.py`, `bridge/browser.ts` | Private world and rendered-session lifecycle |
| `src/swarm/tools.py`, `src/swarm/activities.py` | Python tools and bounded gameplay routines |
| `src/swarm/model.py`, `src/swarm/context.py`, `src/swarm/agent.py` | Model adapter, admission, context policy, explicit loop |
| `src/swarm/run.py`, `src/swarm/cli.py` | Readiness, edits, resume, operator commands |
| `experiments/m1.json`, `agents/a01/` through `agents/a10/` | Editable inputs, no secrets |
| `tests/`, `bridge/tests/`, `docs/milestone-1.md` | Verification and operator instructions |

Generated/ignored: `.local/worlds/<id>/game`, accounts/browser metadata, `runs/<id>/state.sqlite`, manifest, per-agent JSONL, request JSON, and PNG captures. Python model keys never enter the bridge. Game passwords never enter model contexts. Bridge stdout is protocol only; logs use stderr.

Use uv for Python; npm/tsx for the bridge. Pin resolved dependencies in lockfiles. The explicit Python loop uses an initially OpenAI-compatible HTTP adapter. Slick remains a future adapter candidate: its local checkout contains uncommitted work, and current session APIs need verification of usage and fresh context at each follow-up before adoption. No required ZeroMQ, Python channel-router integration, or plugin framework for ten asyncio agents.

### Task 1: Define the Python experiment and upstream dependency

**Files:** Create `pyproject.toml`, `uv.lock`, `.gitignore`, `.gitmodules`, `vendor/rs-sdk` gitlink, `src/swarm/__init__.py`, `src/swarm/config.py`, `src/swarm/types.py`, `bridge/package.json`, `bridge/package-lock.json`, `bridge/tsconfig.json`, `experiments/m1.json`, ten profile/instructions pairs, `tests/test_config.py`, `tests/conftest.py`, `bridge/tests/imports.test.ts`.

**Interfaces:** Pydantic models use strict validation and `extra='forbid'`.
- `AgentKey(run_id: str, world_id: str, agent_id: str)`; `Memory(plan: list[str], beliefs: list[str], relationships: dict[str,str], next_action: str)`; `MemoryRevision(revision: int, value: Memory)`.
- `AgentEntry(id: str, profile_path: Path, instructions_path: Path)`; `ProfileRevision(hash: str, role: str, objective: str, policy: Literal['tableau'], instructions: str)`.
- `Experiment(world_id: str, world_url: str, gateway_url: str, duration_seconds: int, concurrency: int, limits: Limits, model: ModelConfig | None, agents: list[AgentEntry])`.
- `Limits(requests_per_task=8, tools_per_task=16, task_seconds=120, max_output_tokens=2048, max_context_bytes=65536, max_memory_bytes=16384, max_artifact_bytes=1073741824)`.
- `ModelConfig(provider: str, model_id: str, base_url: str, api_key_env: str, context_window: int, cost_limit_usd: float, zero_cost: bool, input_price: float, output_price: float, cache_read_price: float)`; USD/million tokens.
- `load_experiment(path: Path) -> Experiment`; `load_profile(entry: AgentEntry) -> ProfileRevision`.

- [ ] **Step 1: Write failing tests.** Fixtures in conftest provide a valid ten-agent JSON dictionary and a helper that writes it to a temporary file. Assert duplicate ids, unsafe paths, nonfinite/negative limits, and non-loopback game endpoints fail.

```python
def test_example_defaults():
    e = load_experiment(Path('experiments/m1.json'))
    assert len(e.agents) == 10
    assert (e.concurrency, e.duration_seconds, e.model) == (4, 1800, None)
```

- [ ] **Step 2: Run red.** `rtk proxy python3 -m pytest tests/test_config.py -q`; missing implementation/runtime setup must fail, not count as a passing baseline.
- [ ] **Step 3: Implement config/package files.** Python dependencies Pydantic 2/httpx; dev pytest/ruff. Console entry `swarm = swarm.cli:main` is implemented in Task 7. Bridge deps tsx 4, TypeScript 5.9.3, Puppeteer 24, Node types 24; scripts `check` runs strict tsc and node:test via tsx. Add upstream submodule at the exact pin and install its root frozen Bun dependencies. Ignore `/references/`, `.local/`, `runs/`, environments, secrets, and node_modules in parent; do not absorb the reference repo. Profiles are contained within agents/, without symlink escape. Create ten identical individual-profit profiles and null model.
- [ ] **Step 4: Verify green.** `rtk proxy uv run pytest tests/test_config.py -q`; `rtk proxy npm --prefix bridge run check`. Import test loads BotSDK/BotActions/executionContext and constructs an SDK with browser auto-launch off, without network. Report pin incompatibility rather than silently changing it.
- [ ] **Step 5: Commit.** `rtk git add pyproject.toml uv.lock .gitignore .gitmodules vendor/rs-sdk src/swarm/__init__.py src/swarm/config.py src/swarm/types.py bridge/package.json bridge/package-lock.json bridge/tsconfig.json bridge/tests/imports.test.ts experiments agents tests/test_config.py tests/conftest.py`; `rtk git commit -m "feat: define Python agent experiment contracts"`.

### Task 2: Persist private memory and recoverable traces

**Files:** Create `src/swarm/store.py`, `src/swarm/trace.py`, `tests/test_store.py`, `tests/test_trace.py`; modify `src/swarm/types.py`.

**Interfaces:** `Store(path: Path)` provides `read_memory(key) -> MemoryRevision`, `update_memory(key, expected_revision: int, value: Memory, actor: Literal['agent','operator']) -> MemoryRevision`, `append(key, event: EventInput) -> TraceEvent`, `events(key, after_seq: int, limit: int) -> list[TraceEvent]`, and `close()`. TraceEvent adds generated seq/time to AgentKey, event type, optional task/request/action ids, and recursive JSONValue data; EventInput omits generated fields.

Store also exposes `begin_action(key, action_id, intent)`, `end_action(key, action_id, outcome)`, `pending_actions(key) -> list[dict]`, `reserve(key, request_id, upper_usd, cap_usd) -> bool`, `settle(request_id, actual_usd: float | None)`, `spending() -> tuple[float,float]` (settled/reserved). `ActionOutcome(status: Literal['completed','dispatched','failed','uncertain'], message: str, evidence: JSONValue)` is shared with tools.

`Trace(run_dir: Path, store: Store, max_bytes: int)` exposes synchronous bounded local writes `flush(key)`, `context(key, request_id, payload)`, `capture(key, capture_id, png: bytes) -> Path`; write failure raises.

- [ ] **Step 1: Write failing tests.** Use temporary files and a fresh process for a recovery test. Assert 16385-byte memory rejected, unknown fields rejected, revision/event committed together, pending action survives restart, duplicate exports suppressed, and unknown usage keeps reservations.

```python
def test_memory_is_private_and_revision_checked(store, alice, bob):
    memory = Memory(plan=['bank'], beliefs=[], relationships={}, next_action='walk')
    assert store.update_memory(alice, 0, memory, 'agent').revision == 1
    assert store.read_memory(bob).value.plan == []
    with pytest.raises(ValueError, match='revision'):
        store.update_memory(alice, 0, memory, 'operator')
```

- [ ] **Step 2: Run red.** `rtk proxy uv run pytest tests/test_store.py tests/test_trace.py -q`.
- [ ] **Step 3: Implement SQLite/WAL transactions and exports.** Compound run/world/agent keys scope all reads/writes. Recover only partial final JSONL lines; interior corruption fails loudly. Atomic request files cannot overwrite conflicting ids. Count SQLite/WAL and captures toward quota; disk/quota failure halts admission. Sanitize configured credentials and credential-bearing URLs. Unknown spending remains reserved. Tests inject full disk and corrupt-tail failures. No power-loss/exactly-once game claim.
- [ ] **Step 4: Verify green.** Run Task 2 tests and `rtk proxy uv run ruff check src tests`; confirm restart uses disk, not retained objects.
- [ ] **Step 5: Commit.** `rtk git add src/swarm/store.py src/swarm/trace.py src/swarm/types.py tests/test_store.py tests/test_trace.py`; `rtk git commit -m "feat: persist private memory and research traces"`.

### Task 3: Build the narrow Python-to-RS-SDK bridge

**Files:** Create `src/swarm/bridge.py`, `bridge/protocol.ts`, `bridge/main.ts`, `bridge/game.ts`, `tests/test_bridge.py`, `bridge/tests/protocol.test.ts`, `bridge/tests/game.test.ts`; modify `src/swarm/types.py`.

**Interfaces:** Async `Bridge.start(accounts_path: Path, world_url: str, gateway_url: str) -> Bridge`, `bridge.call(agent_id: str, method: str, params: dict, timeout_ms: int, request_id: str) -> dict`, `bridge.cancel(request_id: str) -> dict`, `bridge.close()`.

Request `{v:1,id,agent_id,method,params,timeout_ms}`; response `{v:1,id,ok:true,result}` or `{v:1,id,ok:false,error:{code,message,effects:'none'|'uncertain'}}`. Cancel is its own id with method cancel and target request_id in params. Maximum UTF-8 frame 2 MiB; reject unknown versions/keys/methods. TS `dispatch(request: Request, sessions: Map<string,GameSession>): Promise<Response>`; GameSession owns SDK/BotActions, observation sequence, action AbortController and mutation lock.

`Observation` in Python carries AgentKey, session_epoch, observation_seq, observed_at, age_ms, client_tick, JSON game state and timestamped known_bank or null. Bridge returns scoped state; Python adds run identity. Capture saves under an explicitly supplied local run directory and returns relative path/size, not an oversized base64 frame.

- [ ] **Step 1: Write failing tests.** A test child emits reordered JSON responses and stderr. Assert slow agent calls do not block other agents, late responses never resolve another id, malformed/oversize frames fail, duplicate action ids execute once, conflicting duplicates fail, and EOF leaves sent effects uncertain.

```python
def test_response_ids_isolate_agents(scripted_bridge):
    async def check():
        a = asyncio.create_task(scripted_bridge.call('a01', 'observe', {}, 1000, 'r1'))
        b = asyncio.create_task(scripted_bridge.call('a02', 'observe', {}, 1000, 'r2'))
        await scripted_bridge.reply('r2', {'name': 'Bob'})
        await scripted_bridge.reply('r1', {'name': 'Alice'})
        assert (await a)['name'] == 'Alice'
        assert (await b)['name'] == 'Bob'
    asyncio.run(check())
```

- [ ] **Step 2: Run red.** `rtk proxy uv run pytest tests/test_bridge.py -q`; `rtk proxy npm --prefix bridge run check`.
- [ ] **Step 3: Implement multiplexing/cancellation.** One reader and request-id future map, bounded writes, no resubmission. Node receives only game credentials. SDK uses explicit local URL, control mode, autoLaunchBrowser false, showChat true. AbortSignal/executionContext scopes each operation; process cancel frames while actions await. Release mutation lock only after action settlement; quarantine unresolved actions pending recovery. On stdin EOF abort/disconnect/exit without stopping world/browser. Bound completed-id cache; expired already-seen ids must be rejected, not re-executed. Python journals before sending in Task 4; restarts do not claim exactly-once delivery.
- [ ] **Step 4: Verify green.** Both test suites pass, including one Python test running the actual TS transport with a fake game adapter. Test cancel/complete race, abort suppressing future sends, and absence of API keys in subprocess config. stdout must contain only protocol.
- [ ] **Step 5: Commit.** `rtk git add src/swarm/bridge.py src/swarm/types.py bridge/protocol.ts bridge/main.ts bridge/game.ts tests/test_bridge.py bridge/tests/protocol.test.ts bridge/tests/game.test.ts`; `rtk git commit -m "feat: expose scoped RS-SDK bridge to Python"`.

### Task 4: Start rendered clients and expose Python gameplay tools

**Files:** Create `src/swarm/world.py`, `src/swarm/tools.py`, `src/swarm/activities.py`, `bridge/browser.ts`, `tests/test_world.py`, `tests/test_tools.py`, `tests/live/test_social.py`, `docs/milestone-1.md`; modify `bridge/game.ts`, `src/swarm/types.py`.

**Interfaces:** Async `prepare_world(world_id) -> WorldHandle`, `start_world(world_id) -> WorldHandle`, `stop_world(world_id)`, `start_clients(world: WorldHandle, agents: list[AgentEntry])`. WorldHandle contains world_id, paths, local URLs, revision, tick_ms/xp_rate. Browser operator CLI supports start/focus/capture/close, reconnecting to the owned detached Chromium instance via local metadata.

`Toolset(key: AgentKey, task_id: str, bridge: Bridge, store: Store, trace: Trace)` has `schemas() -> list[dict]` and async `execute(name: str, arguments: dict, call_id: str) -> ActionOutcome`. Python binds agent identity; models cannot supply it. Async `gather(tools: Toolset, skill: Literal['chop','mine','fish'], target: dict, duration_seconds: int) -> ActionOutcome` loops in Python over individual SDK actions.

Tools and strict arguments: get_state/read_memory; update_memory(expected_revision,value); search_events(query,limit 1–50); say(text)/dm(target_name,text), 1–400 chars; walk(x,z); follow(player)/stop_follow; trade_request(player)/trade_offer(items)/trade_accept(partner_name,give,receive)/trade_decline; pickup(ground_item)/drop(item,count); interact_npc(target,option)/interact_loc(target,option); choose_dialog(option)/close_interface; bank_open/bank_deposit(item,count)/bank_withdraw(item,count); shop_open(npc)/shop_buy(item,count)/shop_sell(item,count); equip(item)/unequip(item)/eat(item)/attack(npc); gather(skill,target,duration_seconds 1–30).

Every game action carries observation_seq. References include session_epoch plus NPC index/type id, player index/name, loc id/x/z/plane, inventory slot/item id, or ground id/x/z/plane. Counts are positive integers. Bridge validates latest identity/age immediately before dispatch. Ambiguous names return candidates, never arbitrary selection.

- [ ] **Step 1: Write failing lifecycle/tool tests.** Assert existing saves never overwritten, foreign PIDs/ports never killed, partial startup cleans only owned children, and resume reuses ten tabs. Test common tool registry across agents, prohibited cross-agent parameters, memory authority, success:false, stale identities, cancellation of gathering, and changed trade offers/partners at both acceptance screens.

```python
def test_trade_timeout_is_not_a_retry(tools, bridge):
    bridge.disconnect_after_send = True
    outcome = asyncio.run(tools.execute('trade_accept', accept_args, 'trade1'))
    assert outcome.status == 'uncertain'
    assert bridge.count('trade_accept') == 1
    assert tools.store.pending_actions(tools.key)
```

- [ ] **Step 2: Run red.** `rtk proxy uv run pytest tests/test_world.py tests/test_tools.py -q`.
- [ ] **Step 3: Implement.** Disposable world clone under .local from the upstream pin; install/build/migrate via upstream lockfiles/documented commands. Start engine with login/friend/logger, gateway and rendered client; verify tick 400/XP 1 and loopback binding on ports 8888/7780/43594. Preserve/drain saves on stop. Generate fresh <=12-character alphanumeric names and mode-0600 credentials; tutorial skip is preparation, not model work. Browser lifecycle survives Python/bridge restart. Tools journal before dispatch and persist outcome. Use BotActions helpers in bridge, multi-step economic strategies in Python. A closed trade window is insufficient evidence; verify inventory deltas. Screenshot best effort follows recorded failure and cannot mask it. Caption captures with actual capture time, not a claimed exact action instant.
- [ ] **Step 4: Verify green and real game smoke.** Offline tests pass. `rtk proxy env SWARM_LIVE_GAME=1 uv run pytest tests/live/test_social.py -q` creates three disposable characters/world and proves public chat, Alice-to-Bob DM not received by Carol, follow/stop, two-sided trade, drop/pickup, short gather/bank/shop path, and PNG capture. Without flag, SKIP explicitly. Document exact working setup commands and assets; no mocks passed off as gameplay.
- [ ] **Step 5: Commit.** `rtk git add src/swarm/world.py src/swarm/tools.py src/swarm/activities.py src/swarm/types.py bridge/game.ts bridge/browser.ts tests/test_world.py tests/test_tools.py tests/live/test_social.py docs/milestone-1.md`; `rtk git commit -m "feat: add rendered world and Python gameplay tools"`.

### Task 5: Bound Python model requests and estimated spending

**Files:** Create `src/swarm/model.py`, `tests/test_model.py`; modify `src/swarm/types.py`.

**Interfaces:** `ModelReply(text: str, tool_calls: list[ToolCall], usage: Usage | None, finish_reason: str, raw_message: dict)`; ToolCall has id/name/JSON arguments; Usage has input_tokens/cached_input_tokens/output_tokens. `ModelAdapter` protocol defines async `complete(payload: dict) -> ModelReply`; `OpenAICompatible(config: ModelConfig, client: httpx.AsyncClient)` implements it without automatic retries.

`Gate(store, concurrency: int, max_queued: int)` has async `acquire(key, request_id, upper_usd, cap_usd) -> Lease`; idempotent `Lease.finish(actual_usd: float | None)` releases admission. FIFO bounded by agent count. `upper_request_cost(config,max_output_tokens) -> float` reserves context_window * max(input_price,cache_read_price)/1e6 + output cap * output_price/1e6. `usage_cost(config,usage) -> float` subtracts cached tokens from total input before applying cached pricing.

- [ ] **Step 1: Write failing tests.** Use httpx.MockTransport and controlled asyncio events. Hold four admissions and assert fifth waits until one completes; cancelled queued requests disappear; FIFO holds; double finish harmless; concurrent reservations never exceed cap. Unknown usage retains spending but releases capacity. 429/network errors cause exactly one HTTP attempt. Invalid tool JSON never executes and secrets never appear in recorded errors.

```python
def test_missing_usage_keeps_spending_reserved(store, key):
    assert store.reserve(key, 'r1', .75, 1)
    store.settle('r1', None)
    assert store.spending() == (0, .75)
    assert not store.reserve(key, 'r2', .75, 1)
```

- [ ] **Step 2: Run red.** `rtk proxy uv run pytest tests/test_model.py -q`.
- [ ] **Step 3: Implement adapter/gate.** Non-streaming chat-completions initially; explicit configured base URL, timeouts, output cap and API key env. Bound response body; preserve raw assistant tool_calls for valid follow-ups. Verify supported output-limit behavior; reject modes with unbounded billed reasoning. Explicit zero-cost providers allowed; paid pricing required. Close/cancel HTTP work before releasing capacity, not merely detach it. Unknown usage, including cancellation after send, keeps reservation. Estimates are not hard provider billing guarantees.
- [ ] **Step 4: Verify green.** Run tests and ruff; assert exact outgoing request/tool shape and usage parsing. No paid call needed.
- [ ] **Step 5: Commit.** `rtk git add src/swarm/model.py src/swarm/types.py tests/test_model.py`; `rtk git commit -m "feat: bound Python inference and estimated spending"`.

### Task 6: Build replaceable Python contexts and explicit agent loop

**Files:** Create `src/swarm/context.py`, `src/swarm/agent.py`, `tests/test_context.py`, `tests/test_agent.py`; modify `src/swarm/types.py`.

**Interfaces:** `ContextInput(profile, observation: Observation, memory: MemoryRevision, pending_actions: list[dict], messages: list[dict], tools: list[dict], max_bytes: int)`; `ContextPolicy = Callable[[ContextInput],list[dict]]`; `tableau_context(inputs) -> list[dict]`; `POLICIES={'tableau': tableau_context}`. Ordinary registered Python functions, no dynamic loading from model text.

`AgentDeps(key, bridge, store, trace, gate, model: ModelAdapter, model_config, limits)` dataclass; async `run_task(deps: AgentDeps, profile: ProfileRevision) -> TaskResult`, with task_id/status/reason/requests/tools. New task has new transcript and existing durable memory.

- [ ] **Step 1: Write failing real-loop tests with scripted adapter.** Script memory update, game action, final text. Assert saved JSON equals actual payload, tool call/result ids match, secret notes/DMs stay agent-scoped, and request state is sampled after queue admission.

```python
def test_followup_refreshes_memory_without_stacking_state():
    result = asyncio.run(run_task(scripted_deps, profile))
    assert result.status == 'completed'
    assert count_tableau_blocks(sent[1]['messages']) == 1
    assert read_tableau(sent[1])['memory']['revision'] == 1
    assert sent[1]['messages'][-1]['tool_call_id'] == 'remember1'
```

Also test exact 8-request/16-tool/120-second limits; over-65536-byte context ends before another model call; every unexecuted tool in a budget-exhausted batch receives a matching error result before task archival; disk failure prevents dispatch; unresolved trade intents appear as uncertainty rather than instructions to retry.
- [ ] **Step 2: Run red.** `rtk proxy uv run pytest tests/test_context.py tests/test_agent.py -q`.
- [ ] **Step 3: Implement loop.** Acquire admission, refresh observation/memory, assemble fixed rules + one user-data tableau + current task history, then record exact JSON/options/tool schemas before calling model.complete. Preserve assistant tool_calls and matching role=tool results. Execute sequentially through Toolset with IDs tied to task/request. Python asyncio.timeout/cancellation propagates to bridge; sent actions may remain uncertain. End on final response, limits or error; no automatic replay/continuation of saved requests. Untrusted chat is data. Context changes, memory strategies and activities remain Python-only. Expose complete final outputs, not hidden reasoning.
- [ ] **Step 4: Verify green.** Task 5/6 tests and ruff pass. Inspect one effective adapter payload and test cancellation during both HTTP and bridge waits.
- [ ] **Step 5: Commit.** `rtk git add src/swarm/context.py src/swarm/agent.py src/swarm/types.py tests/test_context.py tests/test_agent.py`; `rtk git commit -m "feat: run Python agents from live tableaux"`.

### Task 7: Expose Python operator workflow and safe resume

**Files:** Create `src/swarm/run.py`, `src/swarm/cli.py`, `tests/test_run.py`, `tests/test_cli.py`, `README.md`; modify `docs/milestone-1.md`.

**Interfaces:** Async `start_run(experiment: Experiment, resume_run_id: str | None = None) -> RunReport`; report has run_id/status/elapsed_seconds/per-agent counts/reasons. argparse `main() -> None` exposes world create/start/stop, clients start --experiment, run --experiment [--resume], status, memory get/set with expected-revision/file, focus, capture, report. Successful commands exit 0, invalid/setup errors 1, incomplete runs 2.

- [ ] **Step 1: Write failing tests.** Real Store plus fake clock/adapters: ninth ready agent never starts paid clock; tenth starts it; 1800-second deadline stops it. Assert 300-second preparation failure, duplicate active ownership rejected, profile changes wait for next task, invalid edits preserve prior valid revision, stale tab detected, and resume retains deadline/spending/memory without repeating pending effects.

```python
def test_profile_change_applies_at_next_task(harness):
    harness.begin_task('a01')
    harness.edit_profile('a01', objective='new')
    assert harness.active_profile('a01').objective == 'old'
    harness.finish_task('a01'); harness.begin_task('a01')
    assert harness.active_profile('a01').objective == 'new'
```

- [ ] **Step 2: Run red.** `rtk proxy uv run pytest tests/test_run.py tests/test_cli.py -q`.
- [ ] **Step 3: Implement lifecycle/CLI.** TaskGroup owns agents and bridge, not separately started game/browser. Exclusive local locks verify owner process rather than evicting live owners. Require explicit model/key/pricing/budget before paid calls. Freeze run config and record profile revision at each task; 1000-ms healthy/5000-ms error delay. Readiness includes tutorial completion/equal initial skills/equipment/coins. Resume same world/accounts and original deadline (downtime counts), conservative spending, and fresh observations. Reconnect SDKs without duplicate browser tabs/controller fights. SIGINT drains traces and settles/cancels bridge work. Memory CLI uses revision-checked Store; capture paths stay within run. Docs show changing a prompt/context function/strategy entirely in Python.
- [ ] **Step 4: Verify green.** Full offline checks pass. `rtk proxy uv run swarm run --experiment experiments/m1.json` rejects null model before any inference. Exercise status/memory commands and local focus/capture. Document exact create-world/start-clients/run/edit/inspect/resume/stop commands and operator-supplied model example.
- [ ] **Step 5: Commit.** `rtk git add src/swarm/run.py src/swarm/cli.py tests/test_run.py tests/test_cli.py README.md docs/milestone-1.md`; `rtk git commit -m "feat: add Python swarm development workflow"`.

### Task 8: Demonstrate ten agents and report acceptance

**Files:** Create `tests/test_acceptance.py`, `tests/live/test_ten_agents.py`, `docs/reports/milestone-1.md`; modify `src/swarm/run.py`, `docs/milestone-1.md`.

**Interfaces:** `check_acceptance(run_dir: Path) -> dict` in run.py reads evidence and writes acceptance.json with passed/checks/missing. No model calls or game replay.

- [ ] **Step 1: Write failing evidence tests.** Offline evidence never passes live acceptance; missing one agent's request/memory/tool evidence fails; incomplete runtime/missing social smoke is named explicitly.

```python
def test_offline_is_not_a_live_demonstration(offline_run):
    result = check_acceptance(offline_run)
    assert not result['passed']
    assert 'live-ten-agent-run' in result['missing']
```

- [ ] **Step 2: Run red.** `rtk proxy uv run pytest tests/test_acceptance.py -q`.
- [ ] **Step 3: Implement live gating/report.** Require SWARM_LIVE_GAME=1, SWARM_LIVE_LLM=1 and explicit experiment path/model/budget. Without inputs, SKIP rather than claiming demonstration. Capture source/dependency/config hashes, world settings, runtime, per-agent cycles/memory/usage/actions, screenshots/errors/interventions. Timeout covers preparation +1800 seconds+drain. Cleanup owns only test-created processes; retain saves/evidence.
- [ ] **Step 4: Verify offline and local game.** `rtk proxy uv run pytest tests -q`; `rtk proxy uv run ruff check src tests`; `rtk proxy npm --prefix bridge run check`; then explicitly gated local social smoke. Fix transport/game issues before paid work.
- [ ] **Step 5: Run configured live demo.** Ten visible tabs for 30 minutes after readiness; each completes model/tool cycle and memory update and attempts individual profit. Edit a profile, restart Python while game/browser remain, close/restore one tab, record interventions. Capture selected PNG and inspect real request/trace from each agent. Economic results are observed, not fabricated. Missing credentials/budget block only this step.
- [ ] **Step 6: Commit tests/report.** `rtk git add tests/test_acceptance.py tests/live/test_ten_agents.py src/swarm/run.py docs/milestone-1.md docs/reports/milestone-1.md`; `rtk git commit -m "test: verify ten-agent Python milestone"`. Raw credentials/traces/images stay ignored. Skipped live checks leave milestone incomplete.

## Self-review and execution handoff

- Coverage: Python config (1), private memory/traces (2), bridge (3), rendered world/tools (4), request limits (5), context/loop (6), workflow/recovery (7), live proof (8).
- All five Review Focus cases have owning tests. Python cancellation is not assumed to stop a remote game effect; bridge settlement/uncertainty are explicit.
- No TypeScript edits for roles, prompts, memory policies or multi-step strategies. New underlying game operations can require bridge maintenance.
- Slick/channel runtime were inspected, not modified. Dependencies were not installed and no live game/model was run during planning.
- No execution approach selected yet. Review the revised plan and choose Subagent-driven or Native before implementation. Model/endpoint/key/tariff/spend ceiling are required only before paid execution.
