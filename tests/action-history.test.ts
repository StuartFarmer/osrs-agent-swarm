import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import {
  actionIntent,
  pendingView,
  inspectAction,
} from "../src/action-history.ts";
import { gatherer } from "../agents/gatherer.ts";
import type { Observation } from "../src/game.ts";
const key = { runId: "r", worldId: "w", agentId: "a" };
const observation = (): Observation => ({
  stamp: { sessionEpoch: "s", observationSeq: 1, observedAt: Date.now() },
  ageMs: 0,
  clientTick: 1,
  knownBank: null,
  raw: {
    tick: 1,
    inGame: true,
    player: { name: "a", worldX: 10, worldZ: 10, level: 0 },
    inventory: [{ slot: 1, id: 995, count: 100, name: "Coins" }],
    equipment: [],
    skills: [],
    nearbyPlayers: [],
    nearbyNpcs: [],
    nearbyLocs: [],
    groundItems: [],
    gameMessages: [],
    bank: { isOpen: false, items: [] },
    shop: { isOpen: false, shopItems: [] },
    dialog: { isOpen: false, options: [] },
    interface: {},
  },
});
test("pending context is bounded and preserves a policy-safe way to inspect durable intents", () => {
  const s = new Store(":memory:");
  const o = observation();
  try {
    for (let i = 0; i < 100; i++) {
      s.beginAction(
        key,
        "a" + i,
        actionIntent(
          {
            kind: "dm",
            targetName: "bob",
            text: "SECRET_DM_SENTINEL",
            stamp: o.stamp,
          },
          o,
        ),
      );
      s.endAction(key, "a" + i, {
        status: "dispatched",
        message: "sent",
        evidence: null,
      });
    }
    const view = pendingView(key, s, 0, 20);
    assert.equal(view.total, 100);
    assert.equal(view.entries.length, 20);
    assert.equal(view.entries[0].kind, "dm");
    const inspected = inspectAction(key, "a0", s, gatherer, o);
    assert.ok(!JSON.stringify(inspected).includes("SECRET_DM_SENTINEL"));
    assert.equal(s.pendingActions(key).length, 100);
    assert.throws(
      () => inspectAction({ ...key, agentId: "b" }, "a0", s, gatherer, o),
      /unknown action/,
    );
  } finally {
    s.close();
  }
});
test("inspection records a fresh postcondition without replaying effects; absent evidence remains uncertain", () => {
  const s = new Store(":memory:");
  const before = observation();
  try {
    s.beginAction(
      key,
      "drop1",
      actionIntent(
        {
          kind: "drop",
          stamp: before.stamp,
          item: { slot: 1, id: 995 },
          count: 100,
        },
        before,
      ),
    );
    s.endAction(key, "drop1", {
      status: "uncertain",
      message: "timeout",
      evidence: null,
    });
    assert.equal(
      inspectAction(key, "drop1", s, gatherer, before).status,
      "uncertain",
    );
    const after = observation();
    after.raw.inventory = [];
    after.clientTick = 2;
    assert.equal(
      inspectAction(key, "drop1", s, gatherer, after).status,
      "completed",
    );
    assert.equal(s.pendingActions(key).length, 0);
    assert.equal(
      s.events(key, 0, 50).filter((e) => e.type === "action_intent").length,
      1,
    );
  } finally {
    s.close();
  }
});
