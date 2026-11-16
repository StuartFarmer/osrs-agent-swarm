import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  prepareWorld,
  stopOwned,
  patchLoopback,
  worldReady,
  patchGatewayReadiness,
} from "../src/world.ts";
test("creating a world refuses existing saves and invalid identifiers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "swarm-world-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".local/worlds/m1/game"), { recursive: true });
  await writeFile(join(root, ".local/worlds/m1/game/save"), "keep");
  await assert.rejects(prepareWorld("m1", root), /exist/);
  assert.equal(
    await readFile(join(root, ".local/worlds/m1/game/save"), "utf8"),
    "keep",
  );
  await assert.rejects(prepareWorld("../escape", root), /identifier/);
});
test("process ownership check refuses to signal an unrelated PID", async () => {
  await assert.rejects(
    stopOwned({
      pid: process.pid,
      token: "not-my-process",
      script: "/not/a/worker",
    }),
    /ownership/,
  );
});
test("loopback patch fails closed on unexpected source and leaves originals intact", () => {
  assert.equal(patchLoopback("host: '0.0.0.0'", 1), "host: '127.0.0.1'");
  assert.throws(() => patchLoopback("host: 'localhost'", 1), /pin/);
});

test("world readiness waits for the gateway login connection, not just HTTP 200", async (t) => {
  let loginConnected = false,
    engineOk = true;
  t.mock.method(globalThis, "fetch", async (url: string | URL) => {
    if (String(url).includes("7780"))
      return Response.json({
        status: "running",
        loginServerConnected: loginConnected,
      });
    return new Response("game", { status: engineOk ? 200 : 503 });
  });
  const world = {
    gameUrl: "http://127.0.0.1:8888",
    gatewayUrl: "ws://127.0.0.1:7780",
  };
  assert.equal(await worldReady(world), false);
  loginConnected = true;
  assert.equal(await worldReady(world), true);
  engineOk = false;
  assert.equal(await worldReady(world), false);
});

test("gateway readiness patch matches the pinned source, is idempotent and fails closed", async () => {
  const source = await readFile(
    new URL("../vendor/rs-sdk/server/gateway/gateway.ts", import.meta.url),
    "utf8",
  );
  const patched = patchGatewayReadiness(source);
  assert.notEqual(patched, source);
  assert.match(patched, /status: 'running',\n\s+loginServerConnected,/);
  assert.equal(patchGatewayReadiness(patched), patched);
  assert.throws(
    () => patchGatewayReadiness("unexpected source"),
    /patch refused/,
  );
});
