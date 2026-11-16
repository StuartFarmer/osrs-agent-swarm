import test from "node:test";
import assert from "node:assert/strict";
import { createGame, sdkTransport, prepareCharacter } from "../src/game.ts";

function fixture(freshnessMs = 3000, stateAgeMs = 0) {
  const raw: any = {
    tick: 1,
    inGame: true,
    player: { name: "a", worldX: 1, worldZ: 1, level: 0 },
    inventory: [
      { slot: 1, id: 995, name: "Coins", count: 100, optionsWithIndex: [] },
      { slot: 5, id: 995, name: "Coins", count: 20, optionsWithIndex: [] },
      {
        slot: 2,
        id: 315,
        name: "Shrimp",
        count: 1,
        optionsWithIndex: [{ text: "Eat", opIndex: 1 }],
      },
    ],
    equipment: [],
    nearbyPlayers: [],
    nearbyNpcs: [],
    nearbyLocs: [],
    groundItems: [],
    gameMessages: [],
    skills: [],
    bank: { isOpen: false, items: [] },
    shop: { isOpen: false, shopItems: [] },
    dialog: { isOpen: false, options: [] },
    interface: {},
  };
  const sent: unknown[] = [];
  const sdk = {
    getState: () => raw,
    getStateReceivedAt: () => Date.now() - stateAgeMs,
    onStateUpdate: () => {},
    disconnect: async () => {},
    sendDropItem: async (slot: number) => {
      sent.push(["drop", slot]);
      return { success: true, phase: "dispatch" };
    },
    sendUseItem: async (slot: number, option: number) => {
      sent.push(["use", slot, option]);
      return { success: true, phase: "dispatch" };
    },
  };
  const bot = {
    dropItem: async () => {
      throw new Error("unsafe whole-slot helper called");
    },
    eatFood: async () => {
      throw new Error("delayed helper called");
    },
  };
  const context = { run: (_context: unknown, work: () => unknown) => work() };
  const transport = sdkTransport(sdk, bot, context, freshnessMs);
  const game = createGame(transport);
  return { game, transport, sent, raw };
}
test("SDK adapter refuses partial-stack drops and sends the exact selected whole slot", async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  const partial = await f.game.execute(
    {
      kind: "drop",
      stamp: f.game.observe().stamp,
      item: { slot: 5, id: 995 },
      count: 1,
    },
    signal,
  );
  assert.equal(partial.status, "failed");
  assert.deepEqual(f.sent, []);
  const whole = await f.game.execute(
    {
      kind: "drop",
      stamp: f.game.observe().stamp,
      item: { slot: 5, id: 995 },
      count: 20,
    },
    signal,
  );
  assert.equal(whole.status, "dispatched");
  assert.deepEqual(f.sent, [["drop", 5]]);
});
test("SDK adapter uses the validated slot immediately rather than a helper with hidden UI waits", async () => {
  const f = fixture();
  const result = await f.game.execute(
    { kind: "eat", stamp: f.game.observe().stamp, item: { slot: 2, id: 315 } },
    new AbortController().signal,
  );
  assert.equal(result.status, "dispatched");
  assert.deepEqual(f.sent, [["use", 2, 1]]);
});
test("an ambiguous post-send failure stays uncertain", async () => {
  const f = fixture();
  const transport = {
    snapshot: () => ({ raw: f.raw, receivedAt: Date.now(), seq: 1 }),
    dispatch: async () => ({ success: false }),
    close: async () => {},
  };
  const game = createGame(transport);
  const result = await game.execute(
    { kind: "say", stamp: game.observe().stamp, text: "hi" },
    new AbortController().signal,
  );
  assert.equal(result.status, "uncertain");
});
test("adapter rechecks live identity even when its caller supplied an older validated snapshot", async () => {
  const f = fixture(),
    before = structuredClone(f.raw),
    stamp = f.game.observe().stamp;
  f.raw.inventory.find((i: any) => i.slot === 2)!.id = 999;
  const result = await f.transport.dispatch(
    { kind: "eat", stamp, item: { slot: 2, id: 315 } },
    before,
    new AbortController().signal,
  );
  assert.equal(result.success, false);
  assert.equal(result.phase, "validation");
  assert.deepEqual(f.sent, []);
});

test("adapter applies the experiment freshness limit immediately before dispatch", async () => {
  const f = fixture(100, 200);
  const result = await f.transport.dispatch(
    { kind: "eat", stamp: f.game.observe().stamp, item: { slot: 2, id: 315 } },
    f.raw,
    new AbortController().signal,
  );
  assert.equal(result.success, false);
  assert.equal(result.phase, "validation");
  assert.deepEqual(f.sent, []);
});

test("real SDK state with named skill access can be observed and becomes ready", async () => {
  const { BotSDK } = await import("../vendor/rs-sdk/sdk/index.ts");
  const sdk = new BotSDK({
    botUsername: "fixture",
    password: "fixture",
    autoLaunchBrowser: false,
  });
  const f = fixture();
  f.raw.skills = [{ name: "Woodcutting", level: 1, experience: 0 }];
  (sdk as any).handleMessage(
    JSON.stringify({
      type: "sdk_state",
      state: f.raw,
      stateReceivedAt: Date.now(),
    }),
  );
  assert.equal((sdk.getState()!.skills as any).Woodcutting.name, "Woodcutting");
  const game = createGame(
    sdkTransport(sdk, {}, { run: (_: unknown, work: () => unknown) => work() }),
  );
  const observation = game.observe();
  assert.deepEqual(observation.raw.skills, f.raw.skills);
  await game.ready(AbortSignal.timeout(100));
  (observation.raw.skills[0] as any).level = 99;
  assert.equal(
    sdk.getState()!.skills[0].level,
    1,
    "observations must remain isolated from live SDK state",
  );
  await game.close();
});

test("preparation leaves mainland characters alone and preserves real tutorial failures", async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  const context = { run: <T>(_context: unknown, work: () => T) => work() };
  let calls = 0;
  const bot = {
    skipTutorial: async () => {
      calls++;
      return { success: false, message: "No Talk option on tutorial NPC" };
    },
  };
  f.raw.player.worldX = 3222;
  f.raw.player.worldZ = 3218;
  await prepareCharacter(f.game, bot, context, signal);
  assert.equal(calls, 0);
  f.raw.player.worldX = 3095;
  f.raw.player.worldZ = 3107;
  await assert.rejects(
    prepareCharacter(f.game, bot, context, signal),
    /No Talk option on tutorial NPC/,
  );
  assert.equal(calls, 1);
});

test("preparation tolerates a tutorial guide arriving after the first in-game state", async () => {
  const f = fixture();
  f.raw.player.worldX = 3095;
  f.raw.player.worldZ = 3107;
  let calls = 0;
  await prepareCharacter(
    f.game,
    {
      skipTutorial: async () => {
        if (++calls === 1)
          return { success: false, message: "No tutorial NPC found" };
        f.raw.player.worldX = 3222;
        f.raw.player.worldZ = 3218;
        return { success: true };
      },
    },
    { run: <T>(_context: unknown, work: () => T) => work() },
    AbortSignal.timeout(5000),
  );
  assert.equal(f.game.observe().raw.player?.worldX, 3222);
});

test("preparation rechecks mainland arrival when the guide disappears during a skip", async () => {
  const f = fixture();
  f.raw.player.worldX = 3095;
  f.raw.player.worldZ = 3107;
  await prepareCharacter(
    f.game,
    {
      skipTutorial: async () => {
        f.raw.player.worldX = 3222;
        f.raw.player.worldZ = 3218;
        return { success: false, message: "No tutorial NPC found" };
      },
    },
    { run: <T>(_context: unknown, work: () => T) => work() },
    AbortSignal.timeout(1000),
  );
});

test("waiting for a missing guide remains cancellable", async () => {
  const f = fixture();
  f.raw.player.worldX = 3095;
  f.raw.player.worldZ = 3107;
  await assert.rejects(
    prepareCharacter(
      f.game,
      {
        skipTutorial: async () => ({
          success: false,
          message: "No tutorial NPC found",
        }),
      },
      { run: <T>(_context: unknown, work: () => T) => work() },
      AbortSignal.timeout(50),
    ),
    { name: "AbortError" },
  );
});

test("a guide that never appears fails with character and location diagnostics", async () => {
  const f = fixture();
  f.raw.player.worldX = 3095;
  f.raw.player.worldZ = 3107;
  await assert.rejects(
    prepareCharacter(
      f.game,
      {
        skipTutorial: async () => ({
          success: false,
          message: "No tutorial NPC found",
        }),
      },
      { run: <T>(_context: unknown, work: () => T) => work() },
      AbortSignal.timeout(35000),
    ),
    (error: any) => {
      assert.match(error.message, /No tutorial NPC found/);
      assert.match(error.message, /"name":"a"/);
      assert.match(error.message, /3095/);
      assert.match(error.message, /3107/);
      assert.match(error.message, /nearbyNpcs/);
      return true;
    },
  );
});
test("tutorial preparation checks arrival on mainland after partial helper success", async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  f.raw.player.worldX = 3095;
  f.raw.player.worldZ = 3107;
  let calls = 0;
  await prepareCharacter(
    f.game,
    {
      skipTutorial: async () => {
        if (++calls === 2) {
          f.raw.player.worldX = 3222;
          f.raw.player.worldZ = 3218;
        }
        return { success: true, message: "Dialog closed" };
      },
    },
    { run: <T>(_context: unknown, work: () => T) => work() },
    signal,
  );
  assert.equal(
    calls,
    2,
    "closing one dialog must not count as finishing the tutorial",
  );
});

test("initial character preparation requests randomized appearance", async () => {
  const f = fixture();
  f.raw.player.worldX = 3095;
  f.raw.player.worldZ = 3107;
  let randomized = false;
  await prepareCharacter(
    f.game,
    {
      skipTutorial: async (options) => {
        randomized = options.randomizeAppearance;
        f.raw.player.worldX = 3222;
        f.raw.player.worldZ = 3218;
        return { success: true };
      },
    },
    { run: <T>(_context: unknown, work: () => T) => work() },
    new AbortController().signal,
  );
  assert.equal(randomized, true);
});
