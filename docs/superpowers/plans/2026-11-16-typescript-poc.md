# Ten-Agent TypeScript POC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run ten visible agents with independently programmable observation/context policies under one shared Pi execution loop.

**Architecture:** The runtime owns waking, inference admission, tools, state and persistence. Trusted agent modules implement observe/buildContext against scoped services; an async Pi stream wrapper invokes them before each provider request. RS-SDK is called directly behind a small game interface, leaving an explicit future bridge boundary without implementing Python transport now.

**Tech Stack:** Node.js 24, TypeScript/tsx, Pi core/AI 0.84.2, TypeBox 1.3.7, node:test/node:sqlite, Puppeteer 24, Bun >=1.3.14 for RS-SDK.

**Spec:** [Current TypeScript POC specification](../specs/2026-11-16-typescript-poc.md). This supersedes the earlier Python-first plan.

## Global Constraints

- Runtime controls waking/execution; agent code controls observation selection and context construction. JSON/Markdown is optional input, not the customization boundary.
- Node.js 24; Pi core/AI 0.84.2; TypeBox 1.3.7; Bun >=1.3.14. RS-SDK pin `3aa493c3d26680df5bae2b475cc1805e3db05ae3`.
- Exactly 10 demo agents, development 1–10; 1800 seconds after readiness; preparation timeout 300 seconds; world tick 400 ms; XP rate 1.
- Global inference concurrency 4. Per task: 8 requests, 16 tools, 120 seconds, 2048 output tokens/request. Activities <=30 seconds, one mutating program per character.
- Freshness <=3000 ms; context <=65536 serialized UTF-8 bytes; memory <=16384 bytes; artifact quota initially 1 GiB.
- Healthy/failure task delays 1000/5000 ms; FIFO admission; no automatic provider retries. No default provider/model/key/tariff/spend cap.
- Local world only; no public fallback, destructive reset, arbitrary code tools, or assumed exactly-once effects.
- Leave references and sibling repositories unchanged. Prefix shell commands with rtk. All paths below are relative to osrs-bot-swarm.

## Review Focus

- Observation filtering bypassed through get_state, history or tool payloads: Task 4 tests excluded-domain leakage with sentinel data.
- State changes during inference queueing: Task 5 samples after admission, including tool follow-ups.
- Slot/entity reuse or changed trade offer: Task 3 revalidates identity and intent before effects.
- Crash after dispatch but before saved result: Tasks 2, 3 and 6 preserve uncertainty and never blindly replay.
- Cancelled provider stream or full trace disk: Tasks 2 and 5 release capacity only after settlement and prevent unrecorded effects.

---

## File map and contracts

| Files | Responsibility |
| --- | --- |
| package.json, package-lock.json, tsconfig.json, .gitignore, .gitmodules, vendor/rs-sdk | Runtime and dependency pin |
| src/config.ts, src/types.ts | Strict experiment/shared records |
| src/store.ts, src/trace.ts | Private memory, action/usage journal, file traces |
| src/game.ts, src/world.ts, src/browser.ts | Scoped SDK access and rendered local environment |
| src/agent-definition.ts, src/tools.ts, agents/merchant.ts, agents/gatherer.ts | Agent customization and policy-aware model tools |
| src/inference.ts, src/runtime.ts | Provider admission and shared bounded task loop |
| src/run.ts, src/cli.ts | Readiness, lifecycle, operator workflow |
| experiments/m1.json, agents/profiles/ | Editable run/profile/instruction inputs |
| tests/*.test.ts, tests/live/*.test.ts, docs/milestone-1.md | Offline/live proof and runbook |

Generated/ignored: .local/worlds/<id>/game and account/browser metadata; runs/<id>/state.sqlite, manifest, per-agent JSONL, contexts, screenshots. No secrets committed. Source modules are trusted operator code, not a security sandbox.

### Task 1: Pin dependencies and define experiment records

**Files:** Create package/config files from the map, src/config.ts, src/types.ts, experiments/m1.json, ten profiles/instructions, tests/config.test.ts, tests/compatibility.test.ts.

**Interfaces:** `loadExperiment(path:string):Promise<Experiment>`; `AgentKey={runId,worldId,agentId:string}`; `Memory={plan:string[];beliefs:string[];relationships:Record<string,string>;nextAction:string}`; `MemoryRevision={revision:number;value:Memory}`. `Experiment` names world URLs, duration/concurrency/limits, nullable explicit model config, and entries `{id,definition,profilePath,instructionsPath}`. Model config includes provider/modelId/baseUrl/apiKeyEnv/contextWindow/costLimitUsd/zeroCost and per-million input/output/cache rates. Profile has role/objective/instructions plus hash. Use JSON-compatible records and strict validation.

- [ ] **Step 1: Write failing tests.** Fixture helpers write experiment JSON and assert malformed fields, duplicate ids, path/symlink escape and remote game endpoints rejected.

```ts
test('demo has ten agents and no implicit paid model', async () => {
  const e = await loadExperiment('experiments/m1.json');
  assert.equal(e.agents.length, 10); assert.equal(e.model, null);
  assert.equal(e.concurrency, 4); assert.equal(e.durationSeconds, 1800);
});
```

- [ ] **Step 2: Run red.** `rtk proxy node --test tests/config.test.ts`; missing implementation/setup is expected failure, not a passing baseline.
- [ ] **Step 3: Implement package/config.** Add vendor submodule at exact pin; install upstream frozen root dependencies. Root uses Pi pins, TypeBox 1.3.7, TypeScript 5.9.3, tsx 4, Puppeteer 24 and Node types 24 with exact resolutions locked. Scripts test=node --import tsx --test tests/*.test.ts, typecheck=tsc --noEmit, check=both, swarm=node --import tsx src/cli.ts. Ignore references/local/generated files. Profiles identify registered agent modules rather than user-input import paths.
- [ ] **Step 4: Verify green.** Run config/compatibility tests with node --import tsx and typecheck. Compatibility imports Pi Agent/StreamFn and SDK/BotActions/executionContext under Node 24 without connecting. Report pin incompatibility explicitly.
- [ ] **Step 5: Commit named Task 1 files.** `rtk git commit -m "feat: define TypeScript POC experiment"` after staging only those paths, excluding references.

### Task 2: Implement private persistence and complete traces

**Files:** Create src/store.ts, src/trace.ts, tests/store.test.ts, tests/trace.test.ts; extend src/types.ts.

**Interfaces:** `Store(path)` with readMemory(key), updateMemory(key,expectedRevision,value,actor), append(key,event), events(key,afterSeq,limit), beginAction(key,id,intent), endAction(key,id,outcome), pendingActions(key), reserve(key,requestId,upperUsd,capUsd), settle(requestId,actualUsd|null), spending(), close(). Memory methods return MemoryRevision; events carry generated seq/time, AgentKey and optional task/request/action ids. `ActionOutcome={status:'completed'|'dispatched'|'failed'|'uncertain';message:string;evidence:JsonValue}`. `Trace(runDir,store,maxBytes)` exports flush(key), context(key,requestId,payload), capture(key,id,png):Promise<string>. Returned capture path is run-relative.

- [ ] **Step 1: Write failing tests.** Temporary SQLite and fresh-process reopen; assert memory privacy/conflicts/size and atomic revision event.

```ts
assert.equal(store.updateMemory(alice, 0, memory, 'agent').revision, 1);
assert.deepEqual(store.readMemory(bob).value.plan, []);
assert.throws(() => store.updateMemory(alice, 0, memory, 'operator'), /revision/);
store.beginAction(alice, 'trade1', { kind: 'trade_accept' });
reopen(); assert.equal(store.pendingActions(alice)[0].actionId, 'trade1');
```

Test unknown usage retains reserve; duplicate export suppressed; partial final JSONL recovered, interior corruption rejected; disk/quota error blocks new writes; credentials redacted.
- [ ] **Step 2: Run red.** `rtk proxy node --import tsx --test tests/store.test.ts tests/trace.test.ts`.
- [ ] **Step 3: Implement SQLite transactions/WAL and atomic file exports.** Compound agent keys, revision checks and event ids; reject authoritative/unknown memory fields. Count database/WAL/captures toward quota. Preserve full bounded effective requests/results and all action phases; no silent rotation. Logs for operators can retain raw diagnostics but are never directly exposed to agents.
- [ ] **Step 4: Verify green.** Run Task 2 tests and typecheck; recover from disk, not retained objects.
- [ ] **Step 5: Commit named Task 2 files.** `rtk git commit -m "feat: persist agent memories and traces"`.

### Task 3: Connect a private rendered world and scoped game interface

**Files:** Create src/world.ts, src/browser.ts, src/game.ts, tests/world.test.ts, tests/game.test.ts, tests/live/social.test.ts, docs/milestone-1.md.

**Interfaces:** async prepareWorld/startWorld(worldId):WorldHandle, stopWorld(worldId); WorldHandle contains local paths/URLs/revision/tickMs/xpRate. startBrowser(world,accounts):BrowserHandle with focus(agentId), capture(agentId), connected(agentId), close(). `connectGame(key,account,world):Promise<GameClient>`; GameClient.observe():Observation, ready(signal), execute(action:GameAction,signal):Promise<ActionOutcome>, close(). Observation has sessionEpoch/observationSeq/observedAt/ageMs/clientTick and raw character-scoped SDK state plus timestamped knownBank|null. GameAction is a fixed discriminated union; never a method-name/reflection escape hatch.

- [ ] **Step 1: Write failing tests.** Existing saves refused on creation, foreign processes not killed, browser restart reuses tabs. Fake SDK verifies identity and effects:

```ts
fake.replaceSlot(2, { id: 995, count: 100 });
assert.equal((await game.execute(oldLogDrop, signal)).status, 'failed');
assert.equal(fake.sent.length, 0);
fake.disconnectAfterDispatch = true;
assert.equal((await game.execute(acceptTrade, signal)).status, 'uncertain');
assert.equal(fake.tradeAcceptCount, 1);
```

Also test failed SDK result, changed trade partner/offers at both screens, abort stopping later sends, stale observations, and partial startup cleanup.
- [ ] **Step 2: Run red.** `rtk proxy node --import tsx --test tests/world.test.ts tests/game.test.ts`.
- [ ] **Step 3: Implement.** Clone private world under .local at vendor pin, use upstream lockfiles/migrations/build, loopback ports 8888/7780/43594, login/friend/logger and verified 400-ms/1x settings. Fresh <=12-char account names and private local credentials, tutorial skip, comparable initial assets/skills. Detached owned rendered browser survives harness restarts; no duplicate tabs. Explicit local SDK/control/showChat:true/autoLaunchBrowser:false. Per-character serialized actions use executionContext AbortSignal; retain lock until settlement. Revalidate entity/index/slot identity and trade intent. Persist intent before dispatch and observed outcome afterward; never auto-repeat uncertain effects. Drain owned processes without deleting saves.
- [ ] **Step 4: Verify green and local game.** Offline tests/typecheck; `rtk proxy env SWARM_LIVE_GAME=1 node --import tsx --test tests/live/social.test.ts` verifies public chat, DM to Bob not Carol, follow/stop, settled two-sided trade, drop/pickup and PNG in disposable three-character world. Missing flag means SKIP. Add a short ordinary gather/bank/shop path and record exact setup commands in runbook.
- [ ] **Step 5: Commit named Task 3 files.** `rtk git commit -m "feat: add private rendered game environment"`.

### Task 4: Define programmable agents and enforce observation policy

**Files:** Create src/agent-definition.ts, src/tools.ts, agents/merchant.ts, agents/gatherer.ts, tests/agent-definition.test.ts, tests/tools.test.ts.

**Interfaces:** `AgentDefinition={id:string;observe:(raw:Readonly<Observation>)=>AgentView;buildContext:(input:ContextInput)=>Promise<Message[]>}`. AgentView has `domains:Partial<Record<Domain,JsonValue>>` and `derived:Record<string,JsonValue>`; Domain is position/inventory/chat/nearby/interfaces/bank/shop. ContextInput contains view, read-only scoped memory/history services, immutable objective/instructions, and current taskMessages. Use Pi Message types; buildContext returns message sequence, not tools/provider options. Runtime enforces fixed safety/permission rules separately. `createTools(key,game,store,trace,definition):AgentTool[]` binds ownership; schemas remain common across agents.

- [ ] **Step 1: Write failing policy tests.** Two modules produce distinct projections/contexts with the same runner; excluded sentinel data cannot reappear:

```ts
const modelVisible = await exerciseAllReadPaths(agentWithoutChat, rawWithSecretDM);
assert.equal(JSON.stringify(modelVisible).includes('SECRET_DM_SENTINEL'), false);
assert.equal(JSON.stringify(modelVisible).includes('OTHER_AGENT_MEMORY'), false);
assert.deepEqual(toolNames(merchant), toolNames(gatherer));
```

Also test policy applied to get_state, event search, unsolicited updates and action result payloads; memory conflicts rejected; custom context preserves tool call/result association and exactly one live-state block.
- [ ] **Step 2: Run red.** `rtk proxy node --import tsx --test tests/agent-definition.test.ts tests/tools.test.ts`.
- [ ] **Step 3: Implement hooks and tools.** Registered trusted modules, no model-loaded code. buildContext can retrieve selected memory/history and transform observations. Model tools receive projected state; raw state remains internal for action validation/operator logs. Excluded domains return unavailable; raw SDK results never pass straight into model results. Always return minimal action outcome, with domain-specific evidence filtered by policy. Private history is filtered on read under current policy. Do not retroactively claim secrecy for data exposed by an earlier policy: record changes and start a fresh task.

Tools: get_state/read_memory/update_memory(expectedRevision,value)/search_events(query,limit<=50); say(text)/dm(targetName,text); follow(player)/stop_follow/walk(x,z); trade_request/offer/accept/decline with exact partner/give/receive; pickup/drop with item identity/count; interact_npc/interact_loc with published option; choose_dialog/close_interface; bank_open/deposit/withdraw; shop_open/buy/sell; equip/unequip/eat/attack; gather(skill chop/mine/fish,target,durationSeconds<=30). Mutations carry observation identity and exact entity/slot reference; ambiguous selectors return candidates. Text 1–400 chars, positive finite counts. High-level helpers reuse SDK; no arbitrary code tool. Merchant retrieves trade history; gatherer focuses on resource/inventory observations to demonstrate code-level customization.
- [ ] **Step 4: Verify green.** Run tests/typecheck, including a full tool call under each policy and negative leakage tests. Document how to author a third observe/buildContext module without touching runtime.
- [ ] **Step 5: Commit named Task 4 files.** `rtk git commit -m "feat: add programmable observation and context policies"`.

### Task 5: Run shared Pi tasks with fresh context and bounded inference

**Files:** Create src/inference.ts, src/runtime.ts, tests/inference.test.ts, tests/runtime.test.ts.

**Interfaces:** createProvider(config):{model,stream:StreamFn}; Gate.acquire(key,requestId,upperUsd,capUsd,signal):Promise<Lease>, Lease.finish(actualUsd|null) idempotent. `runTask(deps:{key,game,store,trace,gate,provider,definition,profile,limits},signal):Promise<TaskResult>`; TaskResult has taskId/status/reason/requests/tools. One Pi Agent per task and one global gate.

- [ ] **Step 1: Write failing tests.** Real Pi tool loop with scripted StreamFn; hold four leases and prove fifth waits. Advance state while queued; its first request must contain new state. Tool-follow-up sees changed memory, no stale appended tableaux, valid ids. Saved effective Context equals passed Context. Test cancellation/error capacity release, 8/16/120 limits, byte ceiling at complete exchanges, no retries, disk failure preventing provider dispatch, and pending actions shown as uncertainty.

```ts
await runTask(scriptedDeps, signal);
assert.equal(sentContexts.length, 2);
assert.equal(countLiveBlocks(sentContexts[1]), 1);
assert.equal(readTableau(sentContexts[1]).memory.revision, 1);
assert.deepEqual(recordedContexts, sentContexts);
```

- [ ] **Step 2: Run red.** `rtk proxy node --import tsx --test tests/inference.test.ts tests/runtime.test.ts`.
- [ ] **Step 3: Implement async provider-boundary wrapper.** Acquire FIFO admission, refresh raw state, call observe/buildContext with scoped services, validate provider message structure/limits, record Context/tools/options, then dispatch. Do not mutate persisted transcript or expose provider credentials to modules. Pre-dispatch failure returns a finalized local Pi error/aborted stream, not a hanging/rejected stream. Hold lease until stream settlement. Reserve conservative contextWindow * highest input/cache tariff + output cap * output tariff; settle disjoint actual token fields, retain reservation on unknown usage. Explicit tariff/key/model/cap required. Reject unsupported billing modes with unbounded reasoning. Per-task tools sequential; nested SDK cancellation must settle before reuse. Archive task and start fresh next time, retaining durable memory.
- [ ] **Step 4: Verify green.** Tests/typecheck pass; inspect one real-shaped recorded Context, test model and game cancellation, and verify no internal raw observation escapes custom policy.
- [ ] **Step 5: Commit named Task 5 files.** `rtk git commit -m "feat: run bounded shared Pi execution loop"`.

### Task 6: Add operator workflow, module revisions and safe resume

**Files:** Create src/run.ts, src/cli.ts, tests/run.test.ts, tests/cli.test.ts, README.md; modify docs/milestone-1.md.

**Interfaces:** startRun(experiment,{resumeRunId?,signal}):Promise<RunReport>; report includes runId/status/elapsedSeconds/per-agent counts/reasons. CLI: world create/start/stop, clients start --experiment, run --experiment [--resume], status, memory get/set --expected-revision --file, focus, capture, report. Exit 0 success, 1 setup/config error, 2 incomplete run.

- [ ] **Step 1: Write failing tests.** Readiness barrier waits for all ten, 1800-second clock begins only then, preparation timeout fails at 300 seconds. Duplicate active owner rejected. Profile edits apply next task; invalid edits preserve prior valid version. Resume retains deadline/spending/memory, uncertain actions not replayed, closed tabs reported stale, shutdown leaves separately owned browser/world intact.
- [ ] **Step 2: Run red.** `rtk proxy node --import tsx --test tests/run.test.ts tests/cli.test.ts`.
- [ ] **Step 3: Implement.** Exclusive verified ownership, fixed run manifest and agent-module content hashes. Registered module code changes use a documented harness restart initially; profile/instructions reload at task boundaries. Record changes/interventions. Resume same characters and original deadline (downtime counts); no browser/controller reconnect battles. Healthy/failure delays per spec. Operator edits use revision-checked Store; screenshot paths contained in run. No live model call with null config. Docs show substantive observe/buildContext changes as well as prompts, and preserve local-world stop/save procedure.
- [ ] **Step 4: Verify green.** Full offline checks; CLI run with null model fails before provider call. Exercise status/memory/capture on fixtures/local world. Document actual commands for all operations.
- [ ] **Step 5: Commit named Task 6 files.** `rtk git commit -m "feat: add POC operator and recovery workflow"`.

### Task 7: Record ten-agent acceptance

**Files:** Create tests/acceptance.test.ts, tests/live/ten-agents.test.ts, docs/reports/milestone-1.md; modify src/run.ts and runbook.

**Interfaces:** checkAcceptance(runDir):Promise<{passed:boolean;checks:Record<string,boolean>;missing:string[]}> reads evidence only and writes acceptance.json. Never replays effects or calls model.

- [ ] **Step 1: Write failing evidence tests.** Offline traces cannot pass live check; missing one agent's request/memory/tool proof fails; missing policy-isolation or social smoke evidence fails with named missing check.
- [ ] **Step 2: Run red.** `rtk proxy node --import tsx --test tests/acceptance.test.ts`.
- [ ] **Step 3: Implement gated live scenario/report.** Require SWARM_LIVE_GAME=1, SWARM_LIVE_LLM=1 and explicit operator experiment/model/budget. Missing inputs SKIP, never pass. Record pins/module hashes/settings, full runtime and agent usage/actions/memory revisions, actual contexts, screenshots, interventions and failures. Timeout covers preparation + run + drain. Preserve evidence/saves; cleanup owned processes only.
- [ ] **Step 4: Verify offline and local smoke.** `rtk proxy npm run check`; run gated three-character smoke before spending on models.
- [ ] **Step 5: Run configured 30-minute demo.** Ten visible clients, each completes a model/tool cycle and memory update; two registered context implementations share the same runner. Edit instructions, restart harness, close/restore a tab and record interventions. Inspect each actual context and capture selected PNG. Profit is observed behavior, not a fabricated acceptance result. Missing paid inputs leave this step incomplete while independent work is finished.
- [ ] **Step 6: Commit acceptance files/report.** `rtk git commit -m "test: verify ten-agent TypeScript POC"` after staging only Task 7 files. Raw secrets/traces/images remain ignored; skipped live checks are explicit in report.

## Self-review and handoff

Coverage: foundation (1), memory/traces (2), world/tools boundary (3), code-level customization and observation isolation (4), shared loop (5), operator recovery (6), live evidence (7). All Review Focus conditions have owning tests.

No Python bridge or abstraction framework is built now. GameClient and serialized trace/action records are the future migration boundary. Agent functions would need porting and transport/cancellation integration in a Python version.

Source APIs were inspected earlier; no dependency installation or live compatibility test was performed while planning. Execution approach remains unselected. Review this current plan before implementation; provider inputs are needed only for paid acceptance.
