import test from "node:test";
import assert from "node:assert/strict";
import { refreshKeyBalance } from "../src/openrouter-budget.ts";
import { Gate } from "../src/inference.ts";
import { Store } from "../src/store.ts";
import { loadExperiment } from "../src/config.ts";

test("budget-only evolution uses actual dedicated-key charges across admissions and resumes", async (t) => {
  const preset = await loadExperiment("experiments/concepcion-evolution.json");
  assert.equal(preset.durationSeconds, null);
  assert.equal(preset.model?.costLimitUsd, 10);
  const db = new Store(":memory:");
  t.after(() => db.close());
  const signal = new AbortController().signal;
  const data: {
    usage: number;
    limit: number | null;
    limit_reset: string | null;
    limit_remaining: number;
  } = { usage: 0, limit: null, limit_reset: null, limit_remaining: 10 };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://openrouter.ai/api/v1/key");
    assert.equal(
      new Headers(init.headers).get("authorization"),
      "Bearer dedicated-key",
    );
    return Response.json({ data });
  });
  const read = () => refreshKeyBalance(db, "dedicated-key", 10, signal);
  await assert.rejects(read(), /credit limit/);
  data.limit = 10;
  data.limit_reset = "daily";
  await assert.rejects(read(), /no reset/);
  data.limit_reset = null;
  data.usage = 0.01;
  await assert.rejects(read(), /unused/);
  data.usage = 0;
  await read();
  data.usage = 9.999;
  data.limit_remaining = 0.001;
  await read();
  const gate = new Gate(1, db, true);
  const ticket = await gate.acquire(
    { runId: "r", worldId: "w", agentId: "a" },
    "last",
    0.52,
    10,
    signal,
  );
  ticket.finish(0.49);
  assert.equal(db.spending(), 9.999);
  await assert.rejects(
    refreshKeyBalance(db, "new-key", 10, signal),
    /original OpenRouter key/,
  );
  assert.doesNotMatch(JSON.stringify(db.keyBalance()), /dedicated-key/);
});
