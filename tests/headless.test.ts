import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadExperiment } from "../src/config.ts";
import { spectatorPath, startSpectator } from "../src/spectator.ts";
import { worldStats } from "../src/world.ts";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createCodeTools } from "../src/code-tools.ts";
import { Store } from "../src/store.ts";
import { Trace } from "../src/trace.ts";
import type { GameClient } from "../src/game.ts";

test("SDK scripts journal intent before execution and correlate successful and uncertain outcomes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-script-evidence-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, "state.sqlite"));
  t.after(() => store.close());
  const key = { runId: "r", worldId: "w", agentId: "a" };
  let fail = false;
  const game = {
    executeCode: async () => {
      assert.equal(store.events(key).at(-1)?.type, "script_started");
      const exported = await readFile(
        join(dir, "agents/w/a/events.jsonl"),
        "utf8",
      );
      assert.match(exported, /script_started/);
      if (fail) throw new Error("connection lost after dispatch");
      return { ok: true, result: 42 };
    },
  } as unknown as GameClient;
  const tool = createCodeTools(
    key,
    game,
    store,
    new Trace(dir, store, 10000000),
  )[0];
  await tool.execute("one", { code: "return 42" });
  fail = true;
  await assert.rejects(
    tool.execute("two", { code: "await effect()" }),
    /connection lost/,
  );
  const events = store.events(key);
  assert.deepEqual(
    events.map((e) => e.type),
    ["script_started", "script_result", "script_started", "script_failed"],
  );
  assert.ok(events[0].actionId);
  assert.equal(events[0].actionId, events[1].actionId);
  assert.equal(events[2].actionId, events[3].actionId);
  assert.notEqual(events[0].actionId, events[2].actionId);
  assert.equal((events[3].data as { uncertain: boolean }).uncertain, true);
});

test("headless settings allow the requested population and speed without changing legacy limits", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-headless-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const e = JSON.parse(await readFile("experiments/headless-m1.json", "utf8"));
  assert.equal(
    (await loadExperiment("experiments/headless-m1.json")).world.tickMs,
    400,
  );
  e.world.tickMs = 50;
  e.durationSeconds = 86400;
  e.preparationSeconds = 3600;
  e.concurrency = 50;
  e.agents = Array.from({ length: 1000 }, (_, i) => ({
    ...e.agents[0],
    id: `agent${i}`,
  }));
  const path = join(dir, "e.json");
  await writeFile(path, JSON.stringify(e));
  assert.equal((await loadExperiment(path)).agents.length, 1000);
  for (const change of [
    { clientMode: "browser" },
    { clientMode: "unknown" },
    { world: { ...e.world, tickMs: 49 } },
    { agents: [...e.agents, { ...e.agents[0], id: "overflow" }] },
    { durationSeconds: 604801 },
    { concurrency: 1001 },
  ]) {
    await writeFile(path, JSON.stringify({ ...e, ...change }));
    await assert.rejects(loadExperiment(path));
  }
});

test("spectator routes expose map/cache/feed but never game control or arbitrary queries", () => {
  for (const path of [
    "/",
    "/mapview/",
    "/playerpositions",
    "/worldmap.jag",
    "/worldfeed",
    "/config123",
    "/ondemand.zip",
    "/watch/",
    "/spectator/agents",
    "/spectator/agents/agent1",
    "/viewer/",
  ])
    assert.equal(spectatorPath("GET", path), path);
  for (const path of [
    "/gateway",
    "/bot",
    "/rs2.cgi",
    "/tickstats",
    "/status",
    "/playertraces",
    "/client/../../.env",
    "/mapview/?token=secret",
    "/config/../../status",
    "/spectator/agents/a/actions",
    "/spectator/agents/a?password=bad",
    "/viewer/../../.env",
  ])
    assert.equal(spectatorPath("GET", path), null, path);
  assert.equal(spectatorPath("POST", "/worldfeed"), null);
  assert.equal(spectatorPath("POST", "/spectator/agents/a"), null);
  assert.equal(spectatorPath("GET", "/viewer/?follow=alice"), "/viewer/");
});

test("spectator refuses nonlocal upstreams before listening", async () => {
  assert.throws(
    () => startSpectator({ gameUrl: "http://example.com" }, 0),
    /local endpoint/,
  );
});

test(
  "spectator forwards map and WebSocket data, blocks control, and closes active feeds",
  { timeout: 10000 },
  async (t) => {
    const paths: string[] = [];
    const engine = createServer((req, res) => {
      paths.push(req.url!);
      res.end("map fixture");
    });
    engine.on("upgrade", (req, socket) => {
      paths.push(req.url!);
      assert.equal(req.headers.authorization, undefined);
      const accept = createHash("sha1")
        .update(
          req.headers["sec-websocket-key"] +
            "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
        )
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.write(Buffer.from([0x81, 4, ...Buffer.from("feed")]));
      socket.on("error", () => {});
      socket.on("end", () => socket.end());
    });
    try {
      await new Promise<void>((resolve, reject) => {
        engine.once("error", reject);
        engine.listen(0, "127.0.0.1", resolve);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("sandbox denies loopback listeners");
        return;
      }
      throw error;
    }
    t.after(
      () => new Promise<void>((resolve) => engine.close(() => resolve())),
    );
    const upstreamPort = (engine.address() as import("node:net").AddressInfo)
      .port;
    const proxy = await startSpectator(
      { gameUrl: `http://127.0.0.1:${upstreamPort}` },
      0,
    );
    t.after(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
    const port = (proxy.address() as import("node:net").AddressInfo).port;
    assert.match(
      await (await fetch(`http://127.0.0.1:${port}/mapview/`)).text(),
      /Center on player/,
    );
    assert.equal(
      await (await fetch(`http://127.0.0.1:${port}/playerpositions`)).text(),
      "map fixture",
    );
    assert.equal((await fetch(`http://127.0.0.1:${port}/rs2.cgi`)).status, 404);
    assert.equal(paths.includes("/rs2.cgi"), false);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/worldfeed`);
    const data = await new Promise((resolve) =>
      ws.addEventListener("message", (e) => resolve(e.data), { once: true }),
    );
    assert.equal(data, "feed");
    const closed = new Promise((resolve) =>
      ws.addEventListener("close", resolve, { once: true }),
    );
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await closed;
    assert.ok(paths.some((p) => p.startsWith("/worldfeed")));
  },
);

test("timing endpoint reports measured engine timing and excludes unrelated management fields", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      tick: 123,
      tickRate: 50,
      players: 10,
      avg: { interval: 60 },
      peak: { cycle: 90 },
      overBudget: 4,
      window: 300,
      web: { private: "do not export" },
    }),
  );
  const stats = await worldStats();
  assert.equal(stats.tickRate, 50);
  assert.equal(stats.avg.interval, 60);
  assert.equal("web" in stats, false);
});

test("lite lifecycle preserves sessions across harness detach and cleans up only new owned processes", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      "--import",
      "tsx",
      "tests/fixtures/lite-lifecycle.ts",
      "--swarm-owner=fixture-monitor",
    ],
    { timeout: 15000 },
  );
  assert.match(stdout, /lite lifecycle verified/);
});

test("headless run preserves journals, measures timing and refuses new work after session loss or expired resume", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      "--import",
      "tsx",
      "tests/fixtures/headless-run.ts",
    ],
    { timeout: 15000 },
  );
  assert.match(stdout, /headless run verified/);
});
