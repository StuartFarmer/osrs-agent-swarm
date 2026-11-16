import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  ensureTabs,
  waitForBrowserEndpoint,
  accountsFor,
} from "../src/browser.ts";
test("restarting client management reuses existing tabs; partial startup closes only new tabs", async () => {
  const urls = ["http://127.0.0.1:8888/bot?bot=alice&password=private"];
  let created = 0,
    closed = 0;
  const existing = { url: () => urls[0] };
  const browser: any = {
    pages: async () => [existing],
    newPage: async () => {
      created++;
      return {
        goto: async () => {
          throw new Error("failed");
        },
        close: async () => closed++,
      };
    },
  };
  const alice = { agentId: "a", username: "alice", password: "private" };
  assert.equal(
    (await ensureTabs(browser, "http://127.0.0.1:8888", [alice])).get("a"),
    existing,
  );
  assert.equal(created, 0);
  await assert.rejects(
    ensureTabs(browser, "http://127.0.0.1:8888", [
      alice,
      { ...alice, agentId: "b", username: "bob" },
    ]),
    /failed/,
  );
  assert.equal(closed, 1);
});

// Advance the wall clock without making the regression take 17 real seconds.
test("cold Chrome startup can expose its control connection after 17 seconds", async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "swarm-chrome-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const pending = waitForBrowserEndpoint(profile);
  const result = assert.doesNotReject(async () => {
    assert.equal(await pending, "ws://127.0.0.1:12345/devtools/browser/test");
  });
  await delay(150);
  now = 17000;
  await writeFile(
    join(profile, "DevToolsActivePort"),
    "12345\n/devtools/browser/test",
  );
  await result;
});
test("browser readiness times out clearly when no endpoint appears", async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "swarm-chrome-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  await assert.rejects(
    waitForBrowserEndpoint(profile, 20),
    /Chrome control connection.*browser.log/,
  );
});

test("generated account passwords fit the game protocol and persist across restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-accounts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const world = { dir } as any;
  const entries = [{ id: "alice" }, { id: "bob" }] as any;
  const accounts = await accountsFor(world, entries);
  assert.ok(
    accounts.every((a) => /^[a-f0-9]{20}$/.test(a.password)),
    "game passwords must be at most 20 characters",
  );
  assert.deepEqual(await accountsFor(world, entries), accounts);
  const legacy = accounts.map((a) => ({ ...a, password: "x".repeat(32) }));
  await writeFile(join(dir, "accounts.json"), JSON.stringify(legacy));
  await assert.rejects(accountsFor(world, entries), /password.*20/);
  assert.deepEqual(
    JSON.parse(await readFile(join(dir, "accounts.json"), "utf8")),
    legacy,
    "invalid saved credentials must not be silently changed",
  );
});
test("reused tabs reload when their stored credentials change", async () => {
  let navigated = "";
  const page = {
    url: () => "http://127.0.0.1:8888/bot?bot=alice&password=old",
    goto: async (url: string) => {
      navigated = url;
    },
  };
  const browser = {
    pages: async () => [page],
    newPage: async () => {
      throw new Error("must reuse tab");
    },
  } as any;
  await ensureTabs(browser, "http://127.0.0.1:8888", [
    { agentId: "alice", username: "alice", password: "updated" },
  ]);
  assert.equal(new URL(navigated).searchParams.get("password"), "updated");
});
