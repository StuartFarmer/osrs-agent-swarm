import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { merchant } from "../agents/merchant.ts";
import { gatherer } from "../agents/gatherer.ts";
import { project, historyFor, contextInput } from "../src/agent-definition.ts";
import { createTools } from "../src/tools.ts";
import type { Observation, GameClient } from "../src/game.ts";
const key = { runId: "r", worldId: "w", agentId: "a" };
const raw = {
  stamp: { sessionEpoch: "s", observationSeq: 1, observedAt: Date.now() },
  ageMs: 0,
  clientTick: 1,
  knownBank: null,
  raw: {
    player: { name: "a" },
    inventory: [],
    equipment: [],
    skills: [],
    nearbyPlayers: [],
    nearbyNpcs: [],
    nearbyLocs: [],
    groundItems: [],
    gameMessages: [{ text: "SECRET_DM_SENTINEL" }],
    dialog: {},
    interface: {},
    bank: { items: [] },
    shop: {},
  },
} as unknown as Observation;
const profile = {
  role: "gatherer",
  objective: "Get rich",
  instructions: "Plan first",
  hash: "h",
};
test("agent hooks select different observations and build one live state plus the task transcript", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const task = [{ role: "user" as const, content: "continue", timestamp: 1 }];
  const a = await merchant.buildContext(
    contextInput(merchant, raw, key, store, profile, task),
  );
  const b = await gatherer.buildContext(
    contextInput(gatherer, raw, key, store, profile, task),
  );
  assert.ok(JSON.stringify(a).includes("SECRET_DM_SENTINEL"));
  assert.ok(!JSON.stringify(b).includes("SECRET_DM_SENTINEL"));
  assert.equal(JSON.stringify(b).match(/<live-state>/g)?.length, 1);
  assert.deepEqual(b.at(-1), task[0]);
});
test("excluded chat and other agent data stay out of state, history and action tools", async (t) => {
  const s = new Store(":memory:");
  t.after(() => s.close());
  s.append(key, {
    type: "raw_observation",
    data: { chat: "SECRET_DM_SENTINEL" },
  });
  s.append(
    { ...key, agentId: "b" },
    { type: "memory_updated", data: { nextAction: "OTHER_AGENT_MEMORY" } },
  );
  s.append(key, {
    type: "action_outcome",
    data: {
      status: "completed",
      message: "SECRET_DM_SENTINEL",
      evidence: { chat: "SECRET_DM_SENTINEL" },
    },
  });
  const game: GameClient = {
    observe: () => raw,
    ready: async () => {},
    close: async () => {},
    execute: async () => ({
      status: "completed",
      message: "SECRET_DM_SENTINEL",
      evidence: { chat: "SECRET_DM_SENTINEL" },
    }),
  };
  const trace = { flush: async () => {}, check: () => {} } as any;
  const tools = createTools(key, game, s, trace, gatherer);
  const run = async (name: string, args: any) =>
    tools
      .find((x) => x.name === name)!
      .execute("t", args, new AbortController().signal);
  const visible = [
    project(gatherer, raw),
    historyFor(key, s, "", 50),
    await run("get_state", {}),
    await run("search_events", { query: "", limit: 50 }),
    await run("say", { stamp: raw.stamp, text: "hello" }),
  ];
  assert.ok(!JSON.stringify(visible).includes("SECRET_DM_SENTINEL"));
  assert.ok(!JSON.stringify(visible).includes("OTHER_AGENT_MEMORY"));
  assert.deepEqual(
    tools.map((t) => t.name),
    createTools(key, game, s, trace, merchant).map((t) => t.name),
  );
  await assert.rejects(
    run("say", { stamp: raw.stamp, text: "x".repeat(401) }),
    /arguments/,
  );
  await run("update_memory", {
    expectedRevision: 0,
    value: {
      plan: ["sell"],
      beliefs: [],
      relationships: {},
      nextAction: "walk",
    },
  });
  await assert.rejects(
    run("update_memory", {
      expectedRevision: 0,
      value: { plan: [], beliefs: [], relationships: {}, nextAction: "" },
    }),
    /revision/,
  );
  const smallMemoryTool = createTools(key, game, s, trace, gatherer, 256).find(
    (t) => t.name === "update_memory",
  )!;
  await assert.rejects(
    smallMemoryTool.execute("small", {
      expectedRevision: 1,
      value: {
        plan: ["x".repeat(500)],
        beliefs: [],
        relationships: {},
        nextAction: "",
      },
    }),
    /size/,
  );
});
