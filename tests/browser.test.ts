import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { ensureTabs, waitForBrowserEndpoint } from "../src/browser.ts";
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
