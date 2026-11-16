import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireWorldLock,
  waitForReady,
  runDeadline,
  reloadProfile,
} from "../src/run.ts";
test("world ownership is exclusive and released after shutdown", async (t) => {
  let release: () => Promise<void>;
  try {
    release = await acquireWorldLock("/test/swarm-world-unique");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("sandbox blocks loopback listeners");
      return;
    }
    throw e;
  }
  await assert.rejects(
    acquireWorldLock("/test/swarm-world-unique"),
    /owned|use/i,
  );
  await release();
  await (
    await acquireWorldLock("/test/swarm-world-unique")
  )();
});
test("readiness waits for every agent; timeout aborts preparation", async () => {
  let ready!: () => void;
  const game = (pending: boolean) => ({
    ready: async (signal: AbortSignal) => {
      if (!pending) return;
      await new Promise<void>((resolve, reject) => {
        ready = resolve;
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  });
  let complete = false;
  const ctrl = new AbortController();
  const p = waitForReady([game(false), game(true)], 100, ctrl.signal).then(
    () => (complete = true),
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(complete, false);
  ready();
  await p;
  assert.equal(complete, true);
  await assert.rejects(
    waitForReady([game(true)], 10, ctrl.signal),
    /preparation/,
  );
});
test("resume retains original deadline and counts downtime", () => {
  assert.equal(
    runDeadline({ startedAt: 1000, deadline: 1801000 }, 1800, 900000),
    1801000,
  );
  assert.equal(
    runDeadline({ startedAt: null, deadline: null }, 1800, 900000),
    2700000,
  );
});
test("invalid profile edits preserve last valid version", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "swarm-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "p.json"),
    JSON.stringify({ role: "gatherer", objective: "sell" }),
  );
  await writeFile(join(root, "i.md"), "First version");
  const a = {
    id: "a",
    definition: "gatherer" as const,
    profilePath: "p.json",
    instructionsPath: "i.md",
  };
  const first = await reloadProfile(root, a);
  assert.equal(first.profile.instructions, "First version");
  await writeFile(join(root, "i.md"), "Second version");
  const next = await reloadProfile(root, a, first.profile);
  assert.notEqual(next.profile.hash, first.profile.hash);
  await writeFile(join(root, "p.json"), "bad");
  const invalid = await reloadProfile(root, a, next.profile);
  assert.equal(invalid.profile.hash, next.profile.hash);
  assert.ok(invalid.error);
});
