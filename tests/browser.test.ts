import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import {
  ensureTabs,
  waitForBrowserEndpoint,
  accountsFor,
  gameCanvasFrame,
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

test("local bot accounts share the admin password and preserve saved credentials", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-accounts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const world = { dir } as any;
  const entries = [{ id: "alice" }, { id: "bob" }] as any;
  const namePool = join(dir, "missing.sqlite");
  const accounts = await accountsFor(world, entries, namePool);
  assert.ok(
    accounts.every((a) => a.password === "admin"),
    "all newly created local bots use the shared password",
  );
  assert.deepEqual(await accountsFor(world, entries, namePool), accounts);
  const existing = accounts.map((a) => ({
    ...a,
    password: "previous-password",
  }));
  await writeFile(join(dir, "accounts.json"), JSON.stringify(existing));
  assert.deepEqual(
    await accountsFor(world, entries, namePool),
    existing,
    "changing saved passwords without updating the login database would break authentication",
  );
  const legacy = accounts.map((a) => ({ ...a, password: "x".repeat(32) }));
  await writeFile(join(dir, "accounts.json"), JSON.stringify(legacy));
  await assert.rejects(accountsFor(world, entries, namePool), /password.*20/);
  assert.deepEqual(
    JSON.parse(await readFile(join(dir, "accounts.json"), "utf8")),
    legacy,
    "invalid saved credentials must not be silently changed",
  );
});
test("accounts use collected names and preserve their identities after the pool changes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-accounts-pool-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pool = join(dir, "names.sqlite");
  const db = new DatabaseSync(pool);
  db.exec(
    "CREATE TABLE names(name_key TEXT PRIMARY KEY, display_name TEXT NOT NULL); INSERT INTO names VALUES ('some_name', 'Some Name')",
  );
  const world = { dir } as any,
    entries = [{ id: "agent1" }] as any;
  const accounts = await accountsFor(world, entries, pool);
  assert.equal(accounts[0].username, "some_name");
  assert.equal(accounts[0].displayName, "Some Name");
  db.exec("DELETE FROM names");
  db.close();
  assert.deepEqual(await accountsFor(world, entries, pool), accounts);
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

test("growing and shrinking a roster preserves every saved character and credential", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-grow-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const world = { dir } as any;
  const entries = Array.from({ length: 25 }, (_, i) => ({
    id: `agent${i + 1}`,
  })) as any;
  const pool = join(dir, "missing.sqlite");
  const first = await accountsFor(world, entries.slice(0, 10), pool);
  first[0].password = "saved-password";
  await writeFile(join(dir, "accounts.json"), JSON.stringify(first));
  await writeFile(join(dir, "character-save"), "progress");
  const expanded = await accountsFor(world, entries, pool);
  assert.equal(expanded.length, 25);
  assert.deepEqual(expanded.slice(0, 10), first);
  assert.equal(new Set(expanded.map((a) => a.username)).size, 25);
  assert.deepEqual(await accountsFor(world, [entries[24], entries[0]], pool), [
    expanded[24],
    expanded[0],
  ]);
  assert.deepEqual(
    JSON.parse(await readFile(join(dir, "accounts.json"), "utf8")),
    expanded,
  );
  assert.equal(await readFile(join(dir, "character-save"), "utf8"), "progress");
  await assert.rejects(
    accountsFor(world, [entries[0], entries[0]], pool),
    /Duplicate/,
  );
  assert.deepEqual(await accountsFor(world, entries, pool), expanded);
  await writeFile(join(dir, "accounts.json.lock"), "");
  await assert.rejects(
    accountsFor(world, entries, pool),
    /already in progress/,
  );
});

test("growing a collected roster keeps names reserved when allocation fails", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-grow-pool-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pool = join(dir, "names.sqlite");
  const db = new DatabaseSync(pool);
  db.exec(
    "CREATE TABLE names(name_key TEXT PRIMARY KEY, display_name TEXT NOT NULL); INSERT INTO names VALUES ('alice', 'Alice')",
  );
  t.after(() => db.close());
  const world = { dir } as any,
    entries = [{ id: "a" }, { id: "b" }] as any;
  const first = await accountsFor(world, entries.slice(0, 1), pool);
  await assert.rejects(accountsFor(world, entries, pool), /pool exhausted/);
  assert.deepEqual(
    JSON.parse(await readFile(join(dir, "accounts.json"), "utf8")),
    first,
  );
  db.exec("INSERT INTO names VALUES ('bob', 'Bob')");
  const expanded = await accountsFor(world, entries, pool);
  assert.deepEqual(expanded[0], first[0]);
  assert.equal(expanded[1].username, "bob");
});

test("recording frames contain only the game canvas and an embedded agent label", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  const game = { width: 765, height: 503 };
  const calls: unknown[] = [];
  const frame = {
    width: 0,
    height: 0,
    getContext: () => ({
      fillRect: () => {},
      drawImage: (...args: unknown[]) => calls.push(args),
      fillText: (...args: unknown[]) => calls.push(args),
    }),
    toDataURL: (format: string) => {
      assert.equal(format, "image/jpeg");
      return "data:image/jpeg;base64,fixture";
    },
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelector: (selector: string) => {
        assert.equal(selector, "#canvas");
        return game;
      },
      createElement: (tag: string) => {
        assert.equal(tag, "canvas");
        return frame;
      },
    },
  });
  try {
    assert.equal(
      gameCanvasFrame("agent1 | Alice | m1"),
      "data:image/jpeg;base64,fixture",
    );
    assert.equal(frame.height, 545);
    assert.deepEqual(calls[0], [game, 0, 42]);
    assert.equal((calls[1] as any[])[0], "agent1 | Alice | m1");
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else delete (globalThis as any).document;
  }
});
