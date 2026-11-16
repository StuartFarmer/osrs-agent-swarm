# RuneBench SDK baseline

The paid OpenRouter preset now uses `agents/runebench.ts` for all ten characters. The earlier merchant/gatherer tableau definitions remain available for later comparisons.

## Basis

[RuneBench's guide](https://github.com/MaxBittker/runebench/blob/main/shared/agents.md) teaches an observe → short script → inspect → extend loop. Its [task generator](https://github.com/MaxBittker/runebench/blob/main/generate-tasks.ts) asks agents to validate one action before writing longer loops. Its [DeepSeek adapters](https://github.com/MaxBittker/runebench/blob/main/agents/deepseek_adapter.py) include Flash variants.

We reuse the pinned rs-sdk's actual `mcp/execute-code.ts`, TypeScript transpiler, cancellation, console capture, `BotActions`, and brief world formatter. The existing `vendor/rs-sdk/wiki/`, `learnings/`, and `sdk/` directories provide shared references, already present in the container. No separate wiki download is needed. The public gold-results bundle exceeded the GitHub/web readers' size limits, so no particular model or strategy is claimed here as a verified leaderboard winner. We retain this experiment's configured world speed, XP rate, and money objective.

## Agent interface

- `execute_code`: TypeScript with its own connected `sdk`, `bot`, `Spells`, and captured console. Default execution budget: 10 seconds; maximum: 60 seconds. Shared task/run deadlines still apply.
- `read_reference` / `search_reference`: paginated reads and literal searches across local SDK source, wiki and learnings.
- `read_memory` / `update_memory`: private notes between tasks. There is no compulsory world tableau on every model request.

Begin with `return sdk.getInventory();`, then one action such as `return await bot.chopTree(/^tree$/i);`. After verifying it works, use a 30-second execution budget for a bounded routine:

```typescript
const end = Date.now() + 20000;
while (Date.now() < end && sdk.getInventory().length < 27) {
  const result = await bot.chopTree(/^tree$/i);
  if (!result.success) { console.log(result); break; }
}
return sdk.getInventory();
```

This illustrates activity, not verified profit. Agents must discover selling/banking and measure results. Read actual API signatures; `bot.mineRock`, `bot.fish`, and `bot.cook` do not exist.

## Context and execution

Each character has a Bun executor and working directory under `runs/RUN_ID/agents/m1/AGENT_ID/workspace/`. Pi retains independent conversations, shared scheduling, four concurrent model requests, traces, and the spending ledger. Results include brief state unless `world: "none"` is requested. Model-visible output is limited to 8 KiB; oversized results are bounded before IPC and journaling. At the context limit, complete oldest assistant/tool exchanges are removed together; the latest exchange and private notes remain. Saved traces retain the actual requests and responses.

The failed tableau run's 43 responses had a median request-prepared-to-response latency of **2.923 seconds**, range **0.956–5.024 seconds**; 20 exceeded three seconds. This measures end-to-end latency, not isolated provider throughput. The same model/prices are retained.

There is no model-action age expiry. Scripts query SDK state when they run. The legacy primitive adapter also no longer expires an issued action because the model took time; current-state, session, item and trade checks remain. Client health checks are separate from action age.

Cancellation asks the executor to unwind, then kills its process if a CPU loop prevents that. Worker death invalidates its observation to prevent further model spending for that character. Restart the harness to reconnect it. Uncertain scripts are never replayed automatically; packets already sent may still affect the game.

**Cooperative research only:** process separation is not a filesystem/network security sandbox. Workers do not inherit the OpenRouter key, but share the container OS user/filesystem. Adversarial evolution requires stronger per-agent OS isolation and protection of saves and other agents' artifacts.

## Start a separate baseline run

For these early tests, use fresh characters and a fresh run each time. From `typescript-poc`, reset the container state volume and rebuild:

```sh
docker compose down --volumes
docker compose up --build -d swarm
docker compose logs -f swarm
```

Keep `OPENROUTER_API_KEY` exported. This explicitly starts a **new run with its own $5 spending cap and 30-minute clock**; spending is not carried forward from the previous ledger. The saved world, characters, browser profiles, and active-run pointer are deleted. Host-mounted traces/videos in `runs/` and the name pool in `.local/hiscores/` are preserved. New-run memory starts empty. Initial inventory/equipment/skill equality is still checked against the fresh characters. Removing only the run pointer leaves progressed characters behind and can fail that check.

Read the new ID from `[run]`. The event log includes `script_started` (submitted code) and `script_result` (bounded upstream output, logs, timing and state), alongside model and Pi tool events. Successful code completion alone does not prove profitable gameplay.

## Verification limits

Offline tests exercise real Pi dispatch, Bun TypeScript execution, context bounds, references, cancellation and worker loss. Docker recording now captures the X11 desktop directly, bypassing the canvas request that timed out. Recording failures are reported without cancelling the agents. Tests cover real FFmpeg encoding with a synthetic screen, and Linux builds also test Xvfb capture. Live Docker gameplay remains unverified here. The legacy milestone acceptance checker still targets two tableau definitions and primitive action journals; it is not an acceptance test for this new baseline.
