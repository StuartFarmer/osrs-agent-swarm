import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { Gate } from "../src/inference.ts";
const key = { runId: "r", worldId: "w", agentId: "a" };
test("FIFO admission holds four streams, drops cancelled waiters, and releases once", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const gate = new Gate(4, store);
  const s = new AbortController().signal;
  const leases = await Promise.all(
    [1, 2, 3, 4].map((n) => gate.acquire(key, "r" + n, 1, 10, s)),
  );
  let admitted = false;
  const abort = new AbortController();
  const fifth = gate.acquire(key, "r5", 1, 10, abort.signal);
  const rejected = assert.rejects(fifth, /abort/i);
  abort.abort();
  await rejected;
  const sixth = gate.acquire(key, "r6", 1, 10, s).then((x) => {
    admitted = true;
    return x;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(admitted, false);
  leases[0].finish(0.1);
  leases[0].finish(0.1);
  const last = await sixth;
  assert.equal(admitted, true);
  for (const lease of leases.slice(1)) lease.finish(null);
  last.finish(0.2);
  assert.equal(store.spending(), 3.3);
});
