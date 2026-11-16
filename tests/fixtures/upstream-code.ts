import assert from "node:assert/strict";
const { executeCode } = await import(
  new URL("../../vendor/rs-sdk/mcp/execute-code.ts", import.meta.url).href
);
const { BotSDK } = await import(
  new URL("../../src/sdk.ts", import.meta.url).href
);
const sdk = new BotSDK({ botUsername: "fixture", autoLaunchBrowser: false });
const state = {
  inGame: true,
  tick: 1,
  player: {
    name: "fixture",
    worldX: 3222,
    worldZ: 3218,
    hp: 10,
    maxHp: 10,
    level: 0,
    combat: { inCombat: false },
  },
  skills: [],
  inventory: [],
  equipment: [],
  nearbyNpcs: [],
  nearbyPlayers: [],
  nearbyLocs: [],
  groundItems: [],
  gameMessages: [],
  dialog: { isOpen: false, options: [] },
  interface: {},
  bank: { isOpen: false, items: [] },
  shop: { isOpen: false, shopItems: [] },
};
(sdk as any).handleMessage(
  JSON.stringify({ type: "sdk_state", state, stateReceivedAt: Date.now() }),
);
const connection = { sdk, bot: {}, connected: true, lastShownMessageTick: -1 };
const manager = { get: () => connection, connect: async () => connection };
const result = await executeCode(
  manager,
  "fixture",
  "const x: number = 3; console.log('query', x); return sdk.getState().player.worldX + x;",
  1000,
  undefined,
  undefined,
  { world: "brief" },
);
assert.equal(result.structuredContent.ok, true, JSON.stringify(result));
assert.equal(result.structuredContent.result, 3225);
assert.match(result.structuredContent.logs.join("\n"), /query 3/);
assert.equal(result.structuredContent.world.player.name, "fixture");
const failed = await executeCode(
  manager,
  "fixture",
  "throw new Error('script failure')",
  1000,
  undefined,
  undefined,
  { world: "none" },
);
assert.equal(failed.structuredContent.error.kind, "exception");
const timeout = await executeCode(
  manager,
  "fixture",
  "await new Promise(() => {});",
  30,
  undefined,
  undefined,
  { world: "none" },
);
assert.equal(timeout.structuredContent.error.kind, "timeout");
