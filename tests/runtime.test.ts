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
import { Trace } from "../src/trace.ts";
import { Gate } from "../src/inference.ts";
import { runTask } from "../src/runtime.ts";
import { gatherer } from "../agents/gatherer.ts";
import { createGame } from "../src/game.ts";
import { loadExperiment } from "../src/config.ts";
const key = { runId: "r", worldId: "w", agentId: "a" };
const model: Model<Api> = {
  id: "script",
  name: "script",
  api: "openai-completions",
  provider: "test",
  baseUrl: "http://localhost",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 65536,
  maxTokens: 2048,
};
function response(
  content: AssistantMessage["content"],
  stopReason: "stop" | "toolUse" = "stop",
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
test("request and tool bounds terminate without retrying provider calls", async (t) => {
  const deps = await setup(t);
  let calls = 0;
  const result = await runTask(
    {
      ...deps,
      limits: { ...deps.limits, requests: 2, tools: 1 },
      provider: {
        model,
        upperUsd: 0,
        capUsd: 0,
        stream: () => {
          calls++;
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
  assert.equal(calls, 2);
  assert.equal(result.tools, 1);
  assert.equal(result.status, "limited");
});
test("context ceiling and failed trace block provider dispatch and settle local failures", async (t) => {
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
  const r = await runTask(
    { ...deps, provider, limits: { ...deps.limits, contextBytes: 1 } },
    new AbortController().signal,
  );
  assert.equal(calls, 0);
  assert.equal(r.status, "failed");
  deps.trace.context = async () => {
    throw new Error("disk full");
  };
  const r2 = await runTask({ ...deps, provider }, new AbortController().signal);
  assert.equal(calls, 0);
  assert.equal(r2.status, "failed");
  assert.equal(deps.store.spending(), 0);
});
