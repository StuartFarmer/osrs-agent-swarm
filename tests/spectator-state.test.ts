import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spectatorAgents, spectatorState } from "../src/spectator-state.ts";
import { viewerAsset } from "../src/viewer-assets.ts";

test("spectator reads only rostered agents through authenticated GET, without exposing credentials or opening controllers", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-observer-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const world = { dir, gatewayUrl: "ws://127.0.0.1:7780" };
  assert.deepEqual(await spectatorAgents(world), []);
  await writeFile(
    join(dir, "accounts.json"),
    JSON.stringify([
      { agentId: "a", username: "alice", password: "private-pass" },
    ]),
  );
  assert.deepEqual(await spectatorAgents(world), [{ id: "a", name: "alice" }]);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    calls++;
    assert.equal(String(url), "http://127.0.0.1:7780/state/alice");
    assert.equal(options.method, "GET");
    assert.deepEqual(options.headers, { Authorization: "Bearer private-pass" });
    return Response.json({
      stateAge: 9000,
      botStatus: "stale",
      state: {
        tick: 5,
        player: { name: "Alice" },
        inventory: [],
        gameMessages: [{ text: "private-pass", token: "secret" }],
        internalSecret: "must not escape",
      },
    });
  });
  assert.equal((await spectatorState(world, "not-in-roster")).status, 404);
  assert.equal(calls, 0);
  const result = await spectatorState(world, "a");
  assert.equal(result.status, 200);
  assert.equal((result.body as any).status, "stale");
  assert.equal((result.body as any).stateAgeMs, 9000);
  assert.doesNotMatch(
    JSON.stringify(result),
    /private-pass|must not escape|"secret"/,
  );
  await assert.rejects(spectatorState(world, "../accounts"));
  await assert.rejects(
    spectatorState({ ...world, gatewayUrl: "ws://remote.example" }, "a"),
    /local endpoint/,
  );
  assert.equal(calls, 1);
});

test("gateway failures do not leak upstream responses and invalid observations fail", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-observer-fail-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "accounts.json"),
    JSON.stringify([{ agentId: "a", username: "alice", password: "pass" }]),
  );
  const world = { dir, gatewayUrl: "ws://localhost:7780" };
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("upstream internal detail", { status: 401 }),
  );
  const result = await spectatorState(world, "a");
  assert.equal(result.status, 502);
  assert.doesNotMatch(JSON.stringify(result), /internal detail/);
  fetch.mock.mockImplementation(async () =>
    Response.json({ state: {}, stateAge: -10 }),
  );
  await assert.rejects(spectatorState(world, "a"), /Invalid gateway/);
});

test("3D asset serving contains decoded paths and symlinks inside the built viewer", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-viewer-assets-")),
    root = join(dir, "build");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(root);
  await writeFile(join(root, "index.html"), "3D app");
  await writeFile(join(root, "worker.js"), "self.onmessage = () => {};");
  await writeFile(join(dir, "private.txt"), "outside");
  await symlink(join(dir, "private.txt"), join(root, "escape.txt"));
  assert.equal(
    (await viewerAsset(root, "/viewer/"))?.type,
    "text/html; charset=utf-8",
  );
  assert.equal(
    (await viewerAsset(root, "/viewer/worker.js"))?.type,
    "application/javascript",
  );
  for (const path of [
    "/viewer/../private.txt",
    "/viewer/%2e%2e/private.txt",
    "/viewer/escape.txt",
    "/viewer/%2fetc/passwd",
    "/viewer/missing.js",
    "/viewer/%00bad",
  ])
    assert.equal(await viewerAsset(root, path), undefined, path);
});
