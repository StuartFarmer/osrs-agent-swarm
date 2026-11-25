import { createServer } from "node:http";
import { once } from "node:events";
import { startBillionContext } from "../src/billion-context.ts";
import { createProvider } from "../src/inference.ts";
import { json } from "../src/agent-definition.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  Context,
  Model,
  Api,
} from "@earendil-works/pi-ai";
import { Store } from "../src/store.ts";
import { createCodeTools } from "../src/code-tools.ts";
import { Trace } from "../src/trace.ts";
import { Gate } from "../src/inference.ts";
import { runTask, restoreConversation, validateMessages } from "../src/runtime.ts";
import { gatherer } from "../agents/gatherer.ts";
import { runebench } from "../agents/runebench.ts";
import { createGame } from "../src/game.ts";
import { loadExperiment } from "../src/config.ts";
import { setTimeout as delay } from "node:timers/promises";
const key = { runId: "r", worldId: "w", agentId: "a" };
test("a saved skill can be revised and called with data on the same character", async t => {
  const { store, game, trace } = await setup(t);
  let code = "";
  game.executeCode = async source => { code = source; return {}; };
  const tools = createCodeTools(key, game, store, trace);
  const call = (name: string, args: object) => tools.find(t => t.name === name)!.execute("id", args);
  await call("save_skill", { name: "probe", description: "first", code: "return 1;" });
  await call("save_skill", { name: "probe", description: "inspect holdings", code: "return input;" });
  assert.equal(store.savedSkills(key).length, 1);
  assert.deepEqual(store.savedSkills({ ...key, agentId: "b" }), []);
  const arg = { item: "logs\n'\`" };
  await call("execute_code", { skill: "probe", input: arg });
  assert.deepEqual(new Function(code)(), arg);
  assert.equal(store.savedSkills(key, "probe")[0].description, "inspect holdings");
});
const model: Model<Api> = {
  id: "script",
  name: "script",
  api: "openai-completions",
  provider: "test",
  baseUrl: "http://localhost",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1048576,
  maxTokens: 2048,
};
function response(
  content: AssistantMessage["content"],
  stopReason: "stop" | "toolUse" | "length" = "stop",
) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    api: model.api,
    provider: "test",
    model: "script",
    content,
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  stream.push({ type: "done", reason: stopReason, message });
  return stream;
}
async function setup(t: any) {
  const dir = await mkdtemp(join(tmpdir(), "swarm-runtime-"));
  const store = new Store(join(dir, "state.sqlite"));
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const raw: any = {
    tick: 1,
    inGame: true,
    player: { name: "a", worldX: 1, worldZ: 1, level: 0 },
    skills: [],
    inventory: [],
    equipment: [],
    nearbyPlayers: [],
    nearbyNpcs: [],
    nearbyLocs: [],
    groundItems: [],
    gameMessages: [{ text: "SECRET_DM_SENTINEL" }],
    bank: { isOpen: false, items: [] },
    shop: { isOpen: false, shopItems: [] },
    dialog: { isOpen: false, options: [] },
    interface: {},
  };
  const game = createGame({
    snapshot: () => ({ raw, receivedAt: Date.now(), seq: raw.tick }),
    dispatch: async () => ({ success: true }),
    close: async () => {},
  });
  const trace = new Trace(dir, store, 10000000);
  const gate = new Gate(4, store);
  const profile = {
    role: "gatherer",
    objective: "Earn coins",
    instructions: "Plan first",
    hash: "h",
  };
  const limits = (await loadExperiment("experiments/m1.json")).limits;
  return {
    dir,
    raw,
    key,
    game,
    store,
    trace,
    gate,
    definition: gatherer,
    profile,
    limits,
  };
}
test("provider truncation stops the agent and settles usage", async (t) => {
  const deps = await setup(t);
  let calls = 0;
  const provider = {
    model: { ...model, contextWindow: 4096, cost: { ...model.cost, input: 1 } },
    upperUsd: 0.01,
    capUsd: 1,
    stream: () => {
      calls++;
      return response([{ type: "text", text: "I" }], "length");
    },
  };
  const truncated = await runTask({ ...deps, provider }, new AbortController().signal);
  assert.equal(truncated.status, "context_exhausted", truncated.reason);
  assert.equal(calls, 1);
  assert.equal(truncated.tools, 0);
  assert.equal(deps.store.spending(), 0.000001);
});

test("real Pi follow-up sees changed memory and one fresh tableau; saved Context equals dispatch", async (t) => {
  const deps = await setup(t);
  const sent: Context[] = [];
  const provider = {
    model,
    upperUsd: 0,
    capUsd: 0,
    stream: (_m: any, c: Context) => {
      sent.push(structuredClone(c));
      if (sent.length === 1)
        return response(
          [
            {
              type: "toolCall",
              id: "m1",
              name: "update_memory",
              arguments: {
                expectedRevision: 0,
                value: {
                  plan: ["sell logs"],
                  beliefs: [],
                  relationships: {},
                  nextAction: "sell",
                },
              },
            },
          ],
          "toolUse",
        );
      return response([{ type: "text", text: "done" }]);
    },
  };
  const result = await runTask(
    { ...deps, provider },
    new AbortController().signal,
  );
  assert.equal(result.status, "completed", result.reason);
  assert.equal(sent.length, 2);
  const second = JSON.stringify(sent[1]);
  assert.ok(second.includes("sell logs"));
  assert.ok(!second.includes("SECRET_DM_SENTINEL"));
  assert.equal(second.match(/<live-state>/g)?.length, 1);
  const files = (await readdir(join(deps.dir, "agents/w/a"))).filter((p) =>
    p.endsWith(".json"),
  );
  const saved = await Promise.all(
    files.map(async (f) =>
      JSON.parse(await readFile(join(deps.dir, "agents/w/a", f), "utf8")),
    ),
  );
  assert.deepEqual(
    saved
      .map((x) => x.context)
      .sort((a, b) => a.messages.length - b.messages.length),
    sent,
  );
});

test("Pi SDK baseline preserves large code, results and complete conversation context", async (t) => {
  const deps = await setup(t);
  deps.raw.nearbyLocs = Array.from({ length: 500 }, (_, id) => ({
    id,
    name: "RAW_OBJECT_SENTINEL",
    x: id,
    z: id,
  }));
  const scripts: string[] = [];
  deps.game.executeCode = async (code) => {
    scripts.push(code);
    return { ok: true, result: "x".repeat(50000), world: null };
  };
  let requests = 0;
  const sent: Context[] = [];
  const result = await runTask(
    {
      ...deps,
      definition: runebench,
      provider: {
        model,
        upperUsd: 0,
        capUsd: 0,
        stream: (_model: any, context: Context) => {
          sent.push(structuredClone(context));
          if (++requests <= 4)
            return response(
              [
                {
                  type: "toolCall",
                  id: `code${requests}`,
                  name: "execute_code",
                  arguments: { code: "//" + "x".repeat(17000) + "\nreturn sdk.getInventory();", timeoutSeconds: 600, world: "full" },
                },
              ],
              "toolUse",
            );
          return response([{ type: "text", text: "Done" }]);
        },
      },
    },
    new AbortController().signal,
  );
  assert.equal(result.status, "completed", result.reason);
  assert.equal(scripts.length, 4);
  assert.ok(scripts.every((code) => code.length > 16000));
  assert.ok(Buffer.byteLength(JSON.stringify(sent.at(-1))) > 65536);
  const results = sent.at(-1)!.messages.filter((m) => m.role === "toolResult");
  assert.equal(results.length, 4);
  for (const result of results) {
    const content = result.content[0];
    assert.equal(content.type, "text");
    if (content.type === "text") assert.equal(JSON.parse(content.text).result.length, 50000);
  }
  for (const context of sent) {
    assert.doesNotMatch(
      JSON.stringify(context),
      /RAW_OBJECT_SENTINEL|live-state/,
    );
    assert.deepEqual(context.tools!.map((t) => t.name).sort(), [
      "execute_code",
      "read_memory",
      "read_reference",
      "read_skills",
      "save_skill",
      "search_reference",
      "update_memory",
    ]);
  }
  assert.equal(
    deps.store.events(key).filter((e) => e.type === "script_result").length,
    4,
  );
});
test("state is collected after queue admission", async (t) => {
  const deps = await setup(t);
  const gate = new Gate(1, deps.store),
    signal = new AbortController().signal;
  const lease = await gate.acquire(key, "held", 0, 0, signal);
  let content = "";
  const task = runTask(
    {
      ...deps,
      gate,
      provider: {
        model,
        upperUsd: 0,
        capUsd: 0,
        stream: (_m: any, c: Context) => {
          content = JSON.stringify(c);
          return response([]);
        },
      },
    },
    signal,
  );
  await new Promise((r) => setImmediate(r));
  deps.raw.player.worldX = 9876;
  lease.finish(0);
  await task;
  assert.ok(content.includes("9876"));
});

test("the next task restores the complete conversation from the durable journal", async (t) => {
  const deps = await setup(t);
  let calls = 0;
  const sent: Context[] = [];
  const provider = {
    model, upperUsd: 0, capUsd: 0,
    stream: (_m: any, context: Context) => {
      sent.push(structuredClone(context));
      if (++calls === 1) return response([{
        type: "toolCall", id: "remember", name: "read_memory", arguments: {},
      }], "toolUse");
      return response([{ type: "text", text: "PREVIOUS_TASK_FINDING" }]);
    },
  };
  const first = await runTask({ ...deps, definition: runebench, provider }, new AbortController().signal);
  assert.equal(first.status, "completed", first.reason);
  const reopened = new Store(join(deps.dir, "state.sqlite"));
  t.after(() => reopened.close());
  const previous = restoreConversation(reopened, key);
  validateMessages(previous);
  assert.equal(previous.filter((m) => m.role === "toolResult").length, 1);
  const second = await runTask({
    ...deps, store: reopened, trace: new Trace(deps.dir, reopened, 10000000),
    definition: runebench, provider,
  }, new AbortController().signal);
  assert.equal(second.status, "completed", second.reason);
  assert.match(JSON.stringify(sent.at(-1)), /PREVIOUS_TASK_FINDING/);
  assert.equal(sent.at(-1)!.messages.filter((m) => m.role === "toolResult").length, 1);
});

test("restoring an interrupted tool exchange records uncertainty without replaying it", async (t) => {
  const deps = await setup(t);
  const message = await response([{
    type: "toolCall", id: "unfinished", name: "execute_code", arguments: { code: "await bot.trade('bob');" },
  }], "toolUse").result();
  deps.store.append(key, { type: "message_end", data: JSON.parse(JSON.stringify({ message })) });
  const messages = restoreConversation(deps.store, key);
  validateMessages(messages);
  const last = messages.at(-1)!;
  assert.equal(last.role, "toolResult");
  if (last.role === "toolResult") assert.equal(last.isError, true);
  assert.match(JSON.stringify(last), /Outcome unknown/);
  assert.equal(deps.store.events(key).length, 1);
});

test("SDK worker loss prevents new provider calls", async (t) => {
  const deps = await setup(t);
  deps.game.observe = () => {
    throw new Error("No state: SDK worker exited");
  };
  let calls = 0;
  const result = await runTask(
    {
      ...deps,
      definition: runebench,
      provider: {
        model,
        upperUsd: 0,
        capUsd: 0,
        stream: () => {
          calls++;
          return response([]);
        },
      },
    },
    new AbortController().signal,
  );
  assert.equal(result.status, "failed");
  assert.equal(calls, 0);
});
test("tasks continue beyond the former request and tool ceilings", async (t) => {
  const deps = await setup(t);
  let calls = 0;
  const result = await runTask(
    {
      ...deps,
      provider: {
        model,
        upperUsd: 0,
        capUsd: 0,
        stream: () => {
          calls++;
          if (calls > 18) return response([{ type: "text", text: "done" }]);
          return response(
            [
              {
                type: "toolCall",
                id: "call" + calls,
                name: "read_memory",
                arguments: {},
              },
            ],
            "toolUse",
          );
        },
      },
    },
    new AbortController().signal,
  );
  assert.equal(calls, 19);
  assert.equal(result.tools, 18);
  assert.equal(result.status, "completed");
});
test("failed traces still block provider dispatch and settle local failures", async (t) => {
  const deps = await setup(t);
  let calls = 0;
  const provider = {
    model,
    upperUsd: 0,
    capUsd: 0,
    stream: () => {
      calls++;
      return response([]);
    },
  };
  deps.trace.context = async () => {
    throw new Error("disk full");
  };
  const r2 = await runTask({ ...deps, provider }, new AbortController().signal);
  assert.equal(calls, 0);
  assert.equal(r2.status, "failed");
  assert.equal(deps.store.spending(), 0);
});

test("aborting a task holds inference admission until the source stream settles", async (t) => {
  const deps = await setup(t),
    gate = new Gate(1, deps.store),
    controller = new AbortController();
  const source = createAssistantMessageEventStream();
  let started!: () => void;
  const dispatch = new Promise<void>((resolve) => (started = resolve));
  const task = runTask(
    {
      ...deps,
      gate,
      provider: {
        model,
        upperUsd: 0,
        capUsd: 0,
        stream: () => {
          started();
          return source;
        },
      },
    },
    controller.signal,
  );
  await dispatch;
  controller.abort();
  let admitted = false;
  const next = gate
    .acquire(key, "after-cancel", 0, 0, new AbortController().signal)
    .then((lease) => {
      admitted = true;
      return lease;
    });
  await delay(20);
  assert.equal(admitted, false);
  const final = await response([]).result();
  source.push({ type: "done", reason: "stop", message: final });
  const result = await task;
  assert.equal(result.status, "aborted");
  (await next).finish(0);
});

test("explicit cancellation stops a stalled context hook and releases admission", async (t) => {
  const deps = await setup(t),
    gate = new Gate(1, deps.store);
  let calls = 0;
  const task = runTask(
    {
      ...deps,
      gate,
      definition: { ...gatherer, buildContext: () => new Promise(() => {}) },
      provider: {
        model,
        upperUsd: 0,
        capUsd: 0,
        stream: () => {
          calls++;
          return response([]);
        },
      },
    },
    AbortSignal.timeout(20),
  );
  const result = await Promise.race([task, delay(200).then(() => null)]);
  assert.ok(
    result,
    "a stalled context hook must not hang the shared task loop",
  );
  assert.equal(result.status, "aborted");
  assert.equal(calls, 0);
  (
    await gate.acquire(key, "after-hook", 0, 0, new AbortController().signal)
  ).finish(0);
});

test("billion-context folds history on the provider wire across tasks and isolates agents", async (t) => {
  const deps = await setup(t);
  const bodies: any[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    const remember = bodies.length === 1;
    const fold = bodies.length === 2;
    if (remember) deps.raw.player.worldX = 3219;
    const delta = remember || fold ? { tool_calls: [{ index: 0, id: remember ? "call_note" : "call_fold", type: "function",
      function: remember ? { name: "update_memory", arguments: JSON.stringify({ expectedRevision: 0,
        value: { plan: ["Sell the logs"], beliefs: [], relationships: {}, nextAction: "Visit the shop" } }) }
        : { name: "compress", arguments: JSON.stringify({ content: "m00002–m00017 Old trades\nThe agent sold eight batches of logs for coins and recorded each completed transaction in its trading notes." }) },
    }] } : { content: "done" };
    const chunk = { id: "fake", object: "chat.completion.chunk", model: "local-test",
      choices: [{ index: 0, delta, finish_reason: remember || fold ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 10000, completion_tokens: 12, total_tokens: 10012 } };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: " + JSON.stringify(chunk) + "\n\ndata: [DONE]\n\n");
  });
  upstream.listen(0, "127.0.0.1");
  try { await once(upstream, "listening"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EPERM") return t.skip("sandbox denies loopback listeners");
    throw e;
  }
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const cancel = new AbortController();
  let service = await startBillionContext(deps.dir, cancel.signal);
  const keyEnv = "SWARM_BILI_MOCK_KEY";
  const prev = process.env[keyEnv];
  process.env[keyEnv] = "fake-local";
  try {
    const provider = createProvider({ provider: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: keyEnv,
      modelId: "local-test", contextWindow: 1048576, rates: model.cost, costLimitUsd: 0, zeroCost: true });
    const run = (agentId: string) => {
      const identity = { ...key, agentId };
      return runTask({ ...deps, key: identity, definition: runebench, provider, compression: service.agent(identity, provider.model) }, cancel.signal);
    };
    for (let i = 0; i < 25; i++) {
      const message = { role: "user", content: `TRADE_${i}_DETAIL ` + "logs changed hands. ".repeat(60), timestamp: Date.now() };
      deps.store.append(key, { type: "message_end", data: { message } });
      deps.store.append(key, { type: "message_end", data: json({ message: await response([{ type: "text", text: "Recorded trade." }]).result() }) });
    }
    const first = await run("a");
    assert.equal(first.status, "completed", first.reason);
    assert.equal(first.tools, 2);
    assert.equal(first.requests, 3);
    const messages = (n: number) => JSON.stringify(bodies[n].messages);
    assert.match(messages(0), /TRADE_2_DETAIL/);
    const prefix = bodies[0].messages.slice(0, -1);
    assert.match(JSON.stringify(prefix), /TRADE_24_DETAIL/);
    assert.deepEqual(bodies[1].messages.slice(0, prefix.length), prefix);
    assert.match(bodies[1].messages.at(-1).content, /Latest character observation:.*3219/s);
    assert.match(bodies[1].messages.at(-1).content, /Private notes:.*Sell the logs/);
    assert.equal(messages(1).split("Latest character observation:").length - 1, 1);
    assert.match(messages(2), /The agent sold eight batches/);
    assert.ok(!messages(2).includes("TRADE_2_DETAIL"), JSON.stringify(bodies[2].messages.slice(-3)).slice(-2500));
    await service.close();
    service = await startBillionContext(deps.dir, cancel.signal);
    assert.equal((await run("a")).status, "completed");
    assert.doesNotMatch(messages(3), /TRADE_2_DETAIL/);
    assert.equal((await run("b")).status, "completed");
    assert.doesNotMatch(messages(4), /sold eight batches|TRADE_2_DETAIL|Sell the logs/);
    assert.equal(bodies.length, 5);
    assert.ok(bodies.every(b => !("max_tokens" in b) && !("max_completion_tokens" in b)));
  } finally {
    if (prev === undefined) delete process.env[keyEnv]; else process.env[keyEnv] = prev;
    await service.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
