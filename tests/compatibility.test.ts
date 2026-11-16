import test from "node:test";
import assert from "node:assert/strict";

test("pinned Pi and upstream SDK import under the required runtime", async () => {
  assert.equal(
    process.versions.node.split(".")[0],
    "24",
    "Install Node 24 before integration checks",
  );
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
