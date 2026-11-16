import test from "node:test";
import assert from "node:assert/strict";
import { verifyRuntime } from "../src/run.ts";

test("pinned Pi and upstream SDK import under the required runtime", async () => {
  assert.equal(
    process.versions.node.split(".")[0],
    "24",
    "Install Node 24 before integration checks",
  );
  assert.doesNotThrow(() => verifyRuntime());
  const { Agent } = await import("@earendil-works/pi-agent-core");
  const sdkPath = "../vendor/rs-sdk/sdk/index.ts";
  const actionsPath = "../vendor/rs-sdk/sdk/actions.ts";
  const executionPath = "../vendor/rs-sdk/sdk/execution-context.ts";
  const [{ BotSDK }, { BotActions }, { executionContext }] = await Promise.all([
    import(sdkPath),
    import(actionsPath),
    import(executionPath),
  ]);
  assert.equal(typeof Agent, "function");
  assert.equal(typeof BotSDK, "function");
  assert.equal(typeof BotActions, "function");
  assert.equal(typeof executionContext.run, "function");
});

test("local world settings enable upstream account auto-registration", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const { worldEnv } = await import("../src/world.ts");
  const { stdout } = await promisify(execFile)(
    "bun",
    [
      "-e",
      "import E from './src/util/Environment.ts'; console.log(JSON.stringify({ sdk: E.WEBSITE_REGISTRATION, game: E.website.registration }));",
    ],
    {
      cwd: fileURLToPath(
        new URL("../vendor/rs-sdk/server/engine", import.meta.url),
      ),
      env: { ...process.env, ...worldEnv },
    },
  );
  assert.deepEqual(JSON.parse(stdout), { sdk: false, game: false });
});
