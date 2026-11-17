import { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "swarm-headless-run-"));
const moduleUrl = (name: string) =>
  new URL(`../../src/${name}.ts`, import.meta.url).href;
let attached = 0,
  connected = true,
  closed = 0,
  tick = 0,
  lostDuringTask = false;
const world = {
  id: "m1",
  dir: join(root, ".local/worlds/m1"),
  gameDir: "unused",
  gameUrl: "http://127.0.0.1:8888",
  gatewayUrl: "ws://127.0.0.1:7780",
  tickMs: 50,
  xpRate: 1,
  epoch: "engine-one",
};
mock.module(moduleUrl("world"), {
  namedExports: {
    SDK_REVISION: "fixture",
    readWorld: async () => world,
    acquireWorldLock: async () => async () => {},
    worldStats: async () => ({
      tick: (tick += 20),
      tickRate: 50,
      players: 1,
      avg: { interval: 50 },
      peak: {},
      overBudget: 0,
      window: 20,
    }),
    writeJson: async (path: string, value: unknown) =>
      writeFile(path, JSON.stringify(value)),
  },
});
mock.module(moduleUrl("browser"), {
  namedExports: {
    accountsFor: async () => [
      { agentId: "a", username: "alice", password: "admin" },
    ],
    attachBrowser: async () => {
      throw new Error("Headless run touched Chromium");
    },
  },
});
mock.module(moduleUrl("lite"), {
  namedExports: {
    attachLite: async () => {
      attached++;
      return {
        connected: async () => connected,
        lost: async () => (lostDuringTask ? "a" : undefined),
        close: async () => {
          closed++;
        },
      };
    },
  },
});
mock.module(moduleUrl("game"), {
  namedExports: {
    createGame: () => {},
    connectGame: async () => ({
      ready: async () => {},
      prepare: async () => {},
      close: async () => {},
      observe: () => ({ raw: { inventory: [], equipment: [], skills: [] } }),
    }),
  },
});
mock.module(moduleUrl("inference"), {
  namedExports: {
    Gate: class {},
    createProvider: () => ({}),
  },
});
mock.module(moduleUrl("runtime"), {
  namedExports: {
    runTask: async (_: unknown, signal: AbortSignal) => {
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
      return { status: "cancelled", requests: 1, tools: 1, reason: "deadline" };
    },
  },
});
try {
  await mkdir(join(root, "agents"));
  await writeFile(join(root, "agents/gatherer.ts"), "fixture");
  await writeFile(
    join(root, "agents/a.json"),
    JSON.stringify({ role: "gatherer", objective: "test" }),
  );
  await writeFile(join(root, "agents/a.md"), "test");
  const experiment = JSON.parse(
    await readFile(
      new URL("../../experiments/headless-m1.json", import.meta.url),
      "utf8",
    ),
  );
  experiment.world.tickMs = 50;
  experiment.durationSeconds = 1;
  experiment.agents = [
    {
      id: "a",
      definition: "gatherer",
      profilePath: "agents/a.json",
      instructionsPath: "agents/a.md",
    },
  ];
  const { startRun } = await import("../../src/run.ts");
  await assert.rejects(
    startRun(experiment, { root, record: true }),
    /Headless.*record/,
  );
  const report = await startRun(experiment, { root });
  assert.equal(report.status, "completed");
  assert.equal(report.worldTiming?.configuredTickMs, 50);
  assert.equal(report.worldTiming?.elapsedTicks, 20);
  assert.ok(report.worldTiming!.achievedSpeed > 0);
  assert.equal(attached, 1);
  assert.equal(closed, 1);
  const events = await readFile(
    join(root, "runs", report.runId, "agents/m1/a/events.jsonl"),
    "utf8",
  );
  assert.match(events, /world_start/);
  assert.match(events, /world_end/);
  assert.match(events, /headless/);
  assert.doesNotMatch(events, /screenshot/);
  const resumed = await startRun(experiment, {
    root,
    resumeRunId: report.runId,
  });
  assert.deepEqual(
    resumed,
    report,
    "expired resume must retain completed timing evidence",
  );
  assert.equal(
    attached,
    1,
    "expired resume must not start new clients or inference",
  );
  connected = false;
  const lost = await startRun(experiment, { root });
  assert.equal(lost.status, "incomplete");
  assert.match(lost.failureReason!, /session lost/);
  assert.equal(lost.agents.a.requests, 0);
  connected = true;
  lostDuringTask = true;
  experiment.durationSeconds = 30;
  const interrupted = await startRun(experiment, { root });
  assert.equal(interrupted.status, "incomplete");
  assert.match(interrupted.failureReason!, /session lost/);
  assert.ok(
    interrupted.elapsedSeconds < 15,
    "monitor must cancel an active long-running task",
  );
  console.log("headless run verified");
} finally {
  await rm(root, { recursive: true, force: true });
}
