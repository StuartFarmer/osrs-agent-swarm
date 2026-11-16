import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
test("a smoke browser startup failure releases its world lock and exits", async () => {
  const script = `
    import { mock } from "node:test";
    import { pathToFileURL } from "node:url";
    import { resolve } from "node:path";
    const module = (name) => pathToFileURL(resolve(name)).href;
    mock.module(module("src/run.ts"), { namedExports: {
      verifyRuntime: () => {},
      acquireWorldLock: async () => {
        const handle = setInterval(() => {}, 1000);
        return async () => { clearInterval(handle); console.error("WORLD_LOCK_RELEASED"); };
      },
    }});
    mock.module(module("src/world.ts"), { namedExports: {
      readWorld: async () => ({ dir: "/unused", id: "smoke" }),
      writeJson: async () => {}, SDK_REVISION: "fixture",
    }});
    mock.module(module("src/browser.ts"), { namedExports: {
      accountsFor: async () => [],
      startBrowser: async () => { throw new Error("browser startup fixture failure"); },
    }});
    await import(module("tests/live/social.test.ts"));
  `;
  let result: any;
  try {
    await exec(
      process.execPath,
      [
        "--experimental-test-module-mocks",
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        script,
      ],
      {
        env: { ...process.env, SWARM_LIVE_GAME: "1" },
        timeout: 5000,
      },
    );
    assert.fail("the injected browser failure must fail the smoke test");
  } catch (error) {
    result = error;
  }
  assert.equal(
    result.killed,
    false,
    "failed smoke test must exit without retaining its lock listener",
  );
  assert.equal(result.code, 1);
  assert.match(
    result.stdout + result.stderr,
    /browser startup fixture failure/,
  );
  assert.match(result.stderr, /WORLD_LOCK_RELEASED/);
});
