import test from "node:test";
import assert from "node:assert/strict";
import { createGame } from "../src/game.ts";
const signal = new AbortController().signal;
function fixture() {
  const state: any = {
    tick: 1,
    inGame: true,
    player: { name: "alice", worldX: 3200, worldZ: 3200, level: 0 },
    inventory: [
      { slot: 2, id: 1511, name: "Logs", count: 1, optionsWithIndex: [] },
    ],
    equipment: [],
    nearbyPlayers: [
      { kind: "player", index: 4, name: "bob", x: 3201, z: 3200 },
    ],
    nearbyNpcs: [],
    nearbyLocs: [],
    groundItems: [],
    gameMessages: [],
    skills: [],
    bank: { isOpen: false, items: [] },
    shop: { isOpen: false, shopItems: [] },
    dialog: { isOpen: false, options: [] },
    interface: {},
    trade: {
      isOpen: true,
      screen: "offer",
      partner: "bob",
      myOffer: [],
      theirOffer: [],
    },
  };
  let sent = 0,
    at = Date.now(),
    seq = 1;
  let dispatch: () => Promise<any> = async () => ({
    success: true,
    phase: "dispatch",
  });
  const game = createGame({
    snapshot: () => ({ raw: structuredClone(state), receivedAt: at, seq }),
    dispatch: async () => {
      sent++;
      return dispatch();
    },
    close: async () => {},
  });
  return {
    game,
    state,
    sent: () => sent,
    stamp: () => game.observe().stamp,
    stale: () => {
      at = Date.now() - 4000;
      seq++;
    },
    refresh: () => {
      at = Date.now();
      seq++;
    },
    setDispatch: (d: () => Promise<any>) => (dispatch = d),
  };
}
test("slot reuse, stale observations and foreign sessions refuse effects", async () => {
  const f = fixture();
  const stamp = f.stamp();
  f.state.inventory[0].id = 995;
  assert.equal(
    (
      await f.game.execute(
        { kind: "drop", stamp, item: { slot: 2, id: 1511 }, count: 1 },
        signal,
      )
    ).status,
    "failed",
  );
  assert.equal(f.sent(), 0);
  f.stale();
  assert.equal(
    (await f.game.execute({ kind: "say", stamp, text: "hi" }, signal)).status,
    "failed",
  );
  assert.equal(f.sent(), 0);
  assert.equal(
    (
      await f.game.execute(
        { kind: "say", stamp: { ...stamp, sessionEpoch: "other" }, text: "hi" },
        signal,
      )
    ).status,
    "failed",
  );
});
test("LLM latency does not expire an action when current state still validates it", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture();
  const stamp = f.stamp();
  t.mock.timers.tick(10000);
  // A fresh state arrived while the model was deciding.
  f.refresh();
  const outcome = await f.game.execute(
    { kind: "say", stamp, text: "hello" },
    signal,
  );
  assert.equal(outcome.status, "dispatched");
  assert.equal(f.sent(), 1);
});
test("trade validates partner, screen and exact offers before each acceptance", async () => {
  for (const screen of ["offer", "confirm"] as const) {
    const f = fixture();
    f.state.trade.screen = screen;
    const stamp = f.stamp();
    f.state.trade.theirOffer = [{ id: 995, count: 1 }];
    assert.equal(
      (
        await f.game.execute(
          {
            kind: "trade_accept",
            stamp,
            partner: "bob",
            screen,
            give: [],
            receive: [],
          },
          signal,
        )
      ).status,
      "failed",
    );
    f.state.trade.theirOffer = [];
    f.state.trade.partner = "carol";
    assert.equal(
      (
        await f.game.execute(
          {
            kind: "trade_accept",
            stamp,
            partner: "bob",
            screen,
            give: [],
            receive: [],
          },
          signal,
        )
      ).status,
      "failed",
    );
    assert.equal(f.sent(), 0);
  }
});
test("dispatch failure and disconnect preserve uncertainty without retrying", async () => {
  const f = fixture();
  f.setDispatch(async () => {
    throw new Error("disconnected");
  });
  const r = await f.game.execute(
    { kind: "say", stamp: f.stamp(), text: "hi" },
    signal,
  );
  assert.equal(r.status, "uncertain");
  assert.equal(f.sent(), 1);
  f.setDispatch(async () => ({
    success: false,
    reason: "cant_reach",
    phase: "validation",
  }));
  assert.equal(
    (
      await f.game.execute(
        { kind: "say", stamp: f.stamp(), text: "hi" },
        signal,
      )
    ).status,
    "failed",
  );
});
test("serialization lasts until cancelled work actually settles", async () => {
  const f = fixture();
  let release!: () => void;
  f.setDispatch(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ success: true, phase: "dispatch" });
      }),
  );
  const abort = new AbortController();
  const first = f.game.execute(
    { kind: "say", stamp: f.stamp(), text: "one" },
    abort.signal,
  );
  await new Promise((r) => setImmediate(r));
  abort.abort();
  const second = f.game.execute(
    { kind: "say", stamp: f.stamp(), text: "two" },
    signal,
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(f.sent(), 1);
  release();
  await first;
  await new Promise((r) => setImmediate(r));
  assert.equal(f.sent(), 2);
  release();
  await second;
});

test("readiness reports unexpected snapshot errors instead of silently waiting", async () => {
  const game = createGame({
    snapshot: () => {
      throw new Error("snapshot conversion failed");
    },
    dispatch: async () => ({ success: false }),
    close: async () => {},
  });
  await assert.rejects(
    game.ready(AbortSignal.timeout(50)),
    /snapshot conversion failed/,
  );
});

test("report_player is validated and dispatched as public chat", async () => {
  const f = fixture();
  const stamp = f.stamp();
  const ok = await f.game.execute(
    {
      kind: "report_player",
      stamp,
      targetName: "bob",
      reason: "trade cancelled after promise",
    },
    signal,
  );
  assert.equal(ok.status, "dispatched");
  assert.equal(f.sent(), 1);
  const bad = await f.game.execute(
    { kind: "report_player", stamp, targetName: "bob<script>", reason: "x" },
    signal,
  );
  assert.equal(bad.status, "failed");
  const empty = await f.game.execute(
    { kind: "report_player", stamp, targetName: "bob", reason: "" },
    signal,
  );
  assert.equal(empty.status, "failed");
  assert.equal(f.sent(), 1);
});
