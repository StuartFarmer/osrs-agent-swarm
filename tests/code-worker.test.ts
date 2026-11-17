import test from "node:test";
import assert from "node:assert/strict";
import { fork, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { WorkerRpc } from "../src/code-worker.ts";

test("pinned Bun executor handles TypeScript, SDK reads, brief output, exceptions and timeouts", async () => {
  await promisify(execFile)(
    "bun",
    [fileURLToPath(new URL("./fixtures/upstream-code.ts", import.meta.url))],
    { timeout: 10000 },
  );
});

test("code workers keep messages separate and kill a CPU loop on cancellation", async (t) => {
  const invalidated: number[] = [];
  const workers = [0, 1].map(
    (index) =>
      new WorkerRpc(
        fork(new URL("./fixtures/code-worker.ts", import.meta.url), [], {
          execPath: "bun",
          execArgv: [],
          stdio: ["ignore", "ignore", "inherit", "ipc"],
          env: { PATH: process.env.PATH },
        }),
        (state) => {
          if (state.raw === null) invalidated.push(index);
        },
      ),
  );
  t.after(async () => {
    await Promise.all(workers.map((w) => w.close()));
  });
  assert.deepEqual(
    await Promise.all(
      workers.map((w, i) =>
        w.call("echo", { agent: i }, new AbortController().signal, 5000),
      ),
    ),
    [{ agent: 0 }, { agent: 1 }],
  );
  const large = "x".repeat(100000);
  assert.equal(await workers[1].call("echo", large, new AbortController().signal), large);
  const spin = workers[0].call("spin", {}, AbortSignal.timeout(100));
  assert.equal(
    await workers[1].call(
      "echo",
      "still running",
      new AbortController().signal,
      5000,
    ),
    "still running",
  );
  await assert.rejects(spin, /worker exited|cancel|abort/i);
  assert.ok(
    invalidated.includes(0),
    "a dead worker must invalidate the cached game observation",
  );
  await assert.rejects(
    workers[0].call("echo", {}, new AbortController().signal, 1000),
    /worker exited|closed/i,
  );
});
