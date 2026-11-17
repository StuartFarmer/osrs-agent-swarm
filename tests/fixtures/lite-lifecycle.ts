import { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const dir = await mkdtemp(join(tmpdir(), "swarm-lite-lifecycle-"));
let next = 100,
  failName = "",
  releases = 0;
const owned = new Set<number>();
const calls: any[][] = [];
const fakeExec = () => {};
Object.defineProperty(fakeExec, promisify.custom, {
  value: async (command: string, args: string[]) => {
    assert.equal(command, "ps");
    assert.deepEqual(args, ["-axww", "-o", "pid=", "-o", "command="]);
    return {
      stdout: `  ${process.pid} node tests/fixtures/lite-lifecycle.ts --swarm-owner=fixture-monitor\n999 unrelated process\n`,
    };
  },
});
mock.module("node:child_process", { namedExports: { execFile: fakeExec } });
mock.module(new URL("../../src/world.ts", import.meta.url).href, {
  namedExports: {
    acquireWorldLock: async () => async () => {
      releases++;
    },
    ownsProcess: async (p: any) => owned.has(p.pid),
    stopOwned: async (p: any) => {
      assert.ok(owned.has(p.pid));
      owned.delete(p.pid);
    },
    writeJson: async (path: string, value: unknown) =>
      writeFile(path, JSON.stringify(value)),
    spawnOwned: async (...args: any[]) => {
      calls.push(args);
      if (args[1][1] === failName) throw new Error("injected spawn failure");
      const p = { pid: next++, token: "test", script: args[1][0] };
      owned.add(p.pid);
      return p;
    },
  },
});
const { startLite, stopLite, attachLite } = await import("../../src/lite.ts");
const world = {
  id: "w",
  dir,
  gameDir: join(dir, "game"),
  gameUrl: "http://127.0.0.1:8888",
  gatewayUrl: "ws://127.0.0.1:7780",
  revision: "test",
  tickMs: 400,
  xpRate: 1,
};
const accounts = ["alice", "bob"].map((username) => ({
  username,
  agentId: username,
  password: "admin",
}));
try {
  await mkdir(join(world.gameDir, "server/webclient"), { recursive: true });
  const first = await startLite(world, accounts);
  assert.equal(calls.length, 2);
  assert.equal(await first.connected("alice"), true);
  await first.close();
  assert.equal(owned.size, 2, "harness detach must preserve game sessions");
  await startLite(world, accounts);
  assert.equal(calls.length, 2, "restart must reuse the same sessions");
  assert.equal(
    calls[0][5],
    false,
    "lite processes must not inherit provider credentials",
  );
  const env = await readFile(join(world.gameDir, "bots/alice/bot.env"), "utf8");
  assert.match(env, /SERVER=127.0.0.1:8888/);
  assert.match(env, /GATEWAY_URL=ws:\/\/127.0.0.1:7780/);
  assert.doesNotMatch(env, /API_KEY/);
  await assert.rejects(attachLite(world, [accounts[0]]), /roster/);
  owned.delete(100);
  assert.equal(await first.connected("alice"), false);
  failName = "alice";
  await assert.rejects(startLite(world, accounts), /spawn failure/);
  assert.equal(
    owned.size,
    1,
    "pre-existing Bob must survive failed Alice startup",
  );
  failName = "";
  await startLite(world, accounts);
  assert.equal(
    await first.connected("alice"),
    false,
    "old handle must not accept a replacement session",
  );
  assert.equal(
    await (await attachLite(world, accounts)).connected("alice"),
    true,
  );
  await stopLite(world);
  assert.equal(owned.size, 0);
  failName = "bob";
  await assert.rejects(startLite(world, accounts), /spawn failure/);
  assert.equal(owned.size, 0, "rollback must stop Alice after Bob fails");
  owned.add(999);
  await writeFile(
    join(dir, "browser.json"),
    JSON.stringify({ process: { pid: 999 } }),
  );
  await assert.rejects(startLite(world, accounts), /rendered clients/);
  assert.equal(owned.has(999), true);
  assert.ok(releases >= 6);
  const metadata = JSON.parse(await readFile(join(dir, "lite.json"), "utf8"));
  const current = {
    pid: process.pid,
    token: "fixture-monitor",
    script: "tests/fixtures/lite-lifecycle.ts",
  };
  metadata.processes = { alice: current, bob: current };
  await writeFile(join(dir, "lite.json"), JSON.stringify(metadata));
  assert.equal(await (await attachLite(world, accounts)).lost(), undefined);
  metadata.processes.bob = { ...current, token: "wrong-owner" };
  await writeFile(join(dir, "lite.json"), JSON.stringify(metadata));
  assert.equal(await (await attachLite(world, accounts)).lost(), "bob");
  console.log("lite lifecycle verified");
} finally {
  await rm(dir, { recursive: true, force: true });
}
