import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { localUrl } from "./config.ts";
import type { AgentKey, ActionOutcome, JsonValue } from "./types.ts";
export type Stamp = {
  sessionEpoch: string;
  observationSeq: number;
  observedAt: number;
};
export type ItemRef = { slot: number; id: number };
export type PlayerRef = { index: number; name: string };
export type EntityRef = {
  id: number;
  x: number;
  z: number;
  index?: number;
  level?: number;
};
export type Offer = { id: number; count: number };
type Stamped = { stamp: Stamp };
export type GameAction = Stamped &
  (
    | { kind: "say"; text: string }
    | { kind: "dm"; targetName: string; text: string }
    | { kind: "report_player"; targetName: string; reason: string }
    | { kind: "walk"; x: number; z: number }
    | { kind: "follow" | "trade_request"; player: PlayerRef }
    | {
        kind: "stop_follow" | "trade_decline" | "close_interface" | "bank_open";
      }
    | {
        kind: "trade_offer";
        partner: string;
        give: Offer[];
        receive: Offer[];
        item: ItemRef;
        count: number;
      }
    | {
        kind: "trade_accept";
        partner: string;
        screen: "offer" | "confirm";
        give: Offer[];
        receive: Offer[];
      }
    | {
        kind:
          "drop" | "bank_deposit" | "bank_withdraw" | "shop_buy" | "shop_sell";
        item: ItemRef;
        count: number;
      }
    | { kind: "equip" | "unequip" | "eat"; item: ItemRef }
    | { kind: "pickup"; target: EntityRef }
    | {
        kind: "interact_npc" | "interact_loc";
        target: EntityRef;
        option: number;
      }
    | { kind: "attack" | "shop_open"; target: EntityRef }
    | { kind: "choose_dialog"; pageId: string; option: number }
    | {
        kind: "gather";
        skill: "chop" | "mine" | "fish";
        target: EntityRef;
        durationSeconds: number;
        option: number;
      }
  );
export type Entity = {
  id: number;
  name: string;
  x: number;
  z: number;
  index?: number;
  level?: number;
  optionsWithIndex?: { opIndex: number; text: string }[];
  [key: string]: unknown;
};
export type Item = {
  slot: number;
  id: number;
  count: number;
  name: string;
  [key: string]: unknown;
};
export type RawState = {
  tick: number;
  inGame: boolean;
  player: {
    name: string;
    worldX: number;
    worldZ: number;
    level: number;
    [key: string]: unknown;
  } | null;
  inventory: Item[];
  equipment: Item[];
  nearbyNpcs: Entity[];
  nearbyPlayers: { index: number; name: string; [key: string]: unknown }[];
  nearbyLocs: Entity[];
  groundItems: Entity[];
  gameMessages: unknown[];
  skills: unknown[];
  bank: { isOpen: boolean; items: Item[] };
  shop: { isOpen: boolean; shopItems: Item[] };
  dialog: {
    isOpen: boolean;
    pageId?: string;
    options: { index?: number; [key: string]: unknown }[];
  };
  interface: unknown;
  trade?: {
    isOpen: boolean;
    screen: "offer" | "confirm" | null;
    partner: string | null;
    myOffer: Offer[];
    theirOffer: Offer[];
  };
  [key: string]: unknown;
};
export type Observation = {
  stamp: Stamp;
  ageMs: number;
  clientTick: number;
  raw: RawState;
  knownBank: { observedAt: number; items: Item[] } | null;
};
export type GameClient = {
  observe(): Observation;
  ready(signal: AbortSignal): Promise<void>;
  prepare?(signal: AbortSignal): Promise<void>;
  executeCode?(
    code: string,
    timeoutMs: number,
    signal: AbortSignal,
    world: "brief" | "none",
  ): Promise<unknown>;
  execute(action: GameAction, signal: AbortSignal): Promise<ActionOutcome>;
  close(): Promise<void>;
};
export type Transport = {
  snapshot(): { raw: RawState | null; receivedAt: number; seq: number };
  dispatch(
    action: GameAction,
    state: RawState,
    signal: AbortSignal,
  ): Promise<{ success: boolean; phase?: string; reason?: string }>;
  close(): Promise<void>;
};
const sameOffers = (a: Offer[], b: Offer[]) => {
  const sum = (xs: Offer[]) => {
    const m = new Map<number, number>();
    for (const x of xs) m.set(x.id, (m.get(x.id) || 0) + x.count);
    return [...m].sort((a, b) => a[0] - b[0]);
  };
  return JSON.stringify(sum(a)) === JSON.stringify(sum(b));
};
function validate(a: GameAction, s: RawState): void {
  if (!s.player || !s.inGame) throw new Error("not ready");
  if ("item" in a) {
    const items =
      a.kind === "bank_withdraw"
        ? s.bank.items
        : a.kind === "shop_buy"
          ? s.shop.shopItems
          : a.kind === "unequip"
            ? s.equipment
            : s.inventory;
    const item = items.find(
      (x) => x.slot === a.item.slot && x.id === a.item.id,
    );
    if (!item) throw new Error("item reference changed");
    if (a.kind === "drop" && a.count !== item.count)
      throw new Error("drop requires the entire selected stack");
    if (a.kind === "eat" || a.kind === "equip") {
      const pattern = a.kind === "eat" ? /^eat$/i : /^(wear|wield|equip)$/i;
      if (
        !(
          item.optionsWithIndex as
            { text: string; opIndex: number }[] | undefined
        )?.some((o) => pattern.test(o.text))
      )
        throw new Error("item option unavailable");
    }
    if (
      "count" in a &&
      (!Number.isSafeInteger(a.count) || a.count < 1 || a.count > item.count)
    )
      throw new Error("invalid count");
    if (a.kind.startsWith("bank_") && !s.bank.isOpen)
      throw new Error("bank closed");
    if (a.kind.startsWith("shop_") && !s.shop.isOpen)
      throw new Error("shop closed");
  }
  if (
    "player" in a &&
    !s.nearbyPlayers.some(
      (x) => x.index === a.player.index && x.name === a.player.name,
    )
  )
    throw new Error("player reference changed");
  if ("target" in a) {
    const list =
      a.kind === "pickup"
        ? s.groundItems
        : ["attack", "shop_open", "interact_npc"].includes(a.kind) ||
            (a.kind === "gather" && a.skill === "fish")
          ? s.nearbyNpcs
          : s.nearbyLocs;
    const match = list.find(
      (x) =>
        x.id === a.target.id &&
        (a.target.index !== undefined
          ? x.index === a.target.index
          : x.x === a.target.x &&
            x.z === a.target.z &&
            (a.kind === "pickup" || x.level === a.target.level)),
    );
    if (!match) throw new Error("target reference changed");
    if (
      ["attack", "shop_open", "interact_npc"].includes(a.kind) ||
      (a.kind === "gather" && a.skill === "fish")
    ) {
      if (a.target.index === undefined) throw new Error("NPC index required");
    }
    if (a.kind === "attack" || a.kind === "shop_open") {
      const pattern = a.kind === "attack" ? /^attack$/i : /trade/i;
      if (!match.optionsWithIndex?.some((o) => pattern.test(o.text)))
        throw new Error("NPC option unavailable");
    }
    if (
      "option" in a &&
      !match.optionsWithIndex?.some((o) => o.opIndex === a.option)
    )
      throw new Error("unpublished option");
    if (a.kind === "gather") {
      if (
        !Number.isFinite(a.durationSeconds) ||
        a.durationSeconds <= 0 ||
        a.durationSeconds > 30
      )
        throw new Error("invalid activity duration");
      const option =
        match.optionsWithIndex?.find((o) => o.opIndex === a.option)?.text || "";
      const pattern = {
        chop: /chop/i,
        mine: /mine/i,
        fish: /net|bait|lure|harpoon|cage|fish/i,
      }[a.skill];
      if (!pattern.test(option))
        throw new Error("option is not this gathering skill");
    }
  }
  if (a.kind === "trade_accept" || a.kind === "trade_offer") {
    const t = s.trade;
    if (
      !t?.isOpen ||
      t.partner !== a.partner ||
      t.screen !== (a.kind === "trade_accept" ? a.screen : "offer") ||
      !sameOffers(t.myOffer, a.give) ||
      !sameOffers(t.theirOffer, a.receive)
    )
      throw new Error("trade intent changed");
  }
  if (
    a.kind === "choose_dialog" &&
    (!s.dialog.isOpen ||
      s.dialog.pageId !== a.pageId ||
      !s.dialog.options.some((o) => o.index === a.option))
  )
    throw new Error("dialog changed");
  if (
    "text" in a &&
    (typeof a.text !== "string" || a.text.length < 1 || a.text.length > 400)
  )
    throw new Error("invalid chat length");
  if (a.kind === "dm" && !/^[a-zA-Z0-9 _-]{1,12}$/.test(a.targetName))
    throw new Error("invalid recipient");
  if (
    a.kind === "report_player" &&
    (!/^[a-zA-Z0-9 _-]{1,12}$/.test(a.targetName) ||
      typeof a.reason !== "string" ||
      a.reason.length < 1 ||
      a.reason.length > 200)
  )
    throw new Error("invalid report");
  if (
    a.kind === "walk" &&
    ![a.x, a.z].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 16383)
  )
    throw new Error("invalid coordinates");
}
export function createGame(
  transport: Transport,
  freshnessMs = 3000,
): GameClient {
  const epoch = randomUUID();
  const issued = new Map<number, Stamp>();
  let tail = Promise.resolve();
  let knownBank: Observation["knownBank"] = null;
  let closed = false;
  function observe(): Observation {
    const { raw, receivedAt, seq } = transport.snapshot();
    if (closed || !raw) throw new Error("game offline");
    const stamp = {
      sessionEpoch: epoch,
      observationSeq: seq,
      observedAt: receivedAt,
    };
    issued.set(seq, stamp);
    if (raw.bank.isOpen)
      knownBank = {
        observedAt: receivedAt,
        items: structuredClone(raw.bank.items),
      };
    return {
      stamp,
      ageMs: Date.now() - receivedAt,
      clientTick: raw.tick,
      raw: structuredClone(raw),
      knownBank: structuredClone(knownBank),
    };
  }
  return {
    observe,
    async ready(signal) {
      while (true) {
        signal.throwIfAborted();
        if (closed) throw new Error("game closed");
        const { raw, receivedAt } = transport.snapshot();
        if (raw?.inGame && raw.player && Date.now() - receivedAt <= freshnessMs)
          return;
        await delay(100, undefined, { signal });
      }
    },
    execute(action, signal) {
      const work = tail.then(async (): Promise<ActionOutcome> => {
        let dispatched = false;
        try {
          signal.throwIfAborted();
          const original = issued.get(action.stamp.observationSeq);
          if (
            !original ||
            action.stamp.sessionEpoch !== epoch ||
            original.observedAt !== action.stamp.observedAt
          )
            throw new Error("stale action reference");
          const o = observe();
          if (o.ageMs > freshnessMs) throw new Error("stale state");
          validate(action, o.raw);
          signal.throwIfAborted();
          dispatched = true;
          const r = await transport.dispatch(action, o.raw, signal);
          if (signal.aborted)
            return {
              status: "uncertain",
              message:
                "Action cancelled after dispatch; inspect state before another action.",
              evidence: null,
            };
          return {
            status: r.success
              ? r.phase === "completion"
                ? "completed"
                : "dispatched"
              : r.phase === "validation"
                ? "failed"
                : "uncertain",
            message: r.success
              ? "Action sent; inspect fresh state for its effect."
              : "Action did not confirm success.",
            evidence: null,
          };
        } catch {
          return {
            status: dispatched ? "uncertain" : "failed",
            message: dispatched
              ? "Outcome unknown; inspect state."
              : "Action refused: stale, invalid, changed, or cancelled.",
            evidence: null,
          };
        }
      });
      tail = work.then(
        () => {},
        () => {},
      );
      return work;
    },
    async close() {
      closed = true;
      await transport.close();
      await tail;
    },
  };
}
export async function connectGame(
  key: AgentKey,
  account: { username: string; password: string },
  world: { gatewayUrl: string },
  freshnessMs = 3000,
  scripts = false,
): Promise<GameClient> {
  localUrl(world.gatewayUrl, ["ws:"]);
  const sdkPath = new URL("./sdk.ts", import.meta.url).href;
  const actionsPath = new URL(
    "../vendor/rs-sdk/sdk/actions.ts",
    import.meta.url,
  ).href;
  const contextPath = new URL(
    "../vendor/rs-sdk/sdk/execution-context.ts",
    import.meta.url,
  ).href;
  const [{ BotSDK }, { BotActions }, { executionContext }] = await Promise.all([
    import(sdkPath),
    import(actionsPath),
    import(contextPath),
  ]);
  const sdk = new BotSDK({
    botUsername: account.username,
    password: account.password,
    gatewayUrl: world.gatewayUrl,
    connectionMode: "control",
    autoLaunchBrowser: false,
    autoReconnect: false,
    readyTimeout: 0,
    showChat: true,
    actionTimeout: 30000,
  });
  const bot = new BotActions(sdk);
  try {
    await sdk.connect();
  } catch (e) {
    await sdk.disconnect();
    throw e;
  }
  const game = createGame(
    sdkTransport(sdk, bot, executionContext, freshnessMs),
    freshnessMs,
  );
  game.prepare = (signal) =>
    prepareCharacter(game, bot, executionContext, signal);
  if (scripts) {
    const { executeCode } = await import(
      new URL("../vendor/rs-sdk/mcp/execute-code.ts", import.meta.url).href
    );
    const connection = {
      sdk,
      bot,
      username: account.username,
      connected: true,
      lastShownMessageTick: -1,
    };
    const manager = { get: () => connection, connect: async () => connection };
    game.executeCode = async (code, timeoutMs, signal, world) => {
      const result = await executeCode(
        manager,
        account.username,
        code,
        timeoutMs,
        signal,
        undefined,
        { world },
      );
      return result.structuredContent;
    };
  }
  return game;
}

export async function prepareCharacter(
  game: GameClient,
  bot: {
    skipTutorial(options: {
      randomizeAppearance: boolean;
    }): Promise<{ success: boolean; message?: string }>;
  },
  executionContext: {
    run<T>(context: { signal: AbortSignal }, work: () => T): T;
  },
  signal: AbortSignal,
): Promise<void> {
  const failure = (message: string) => {
    const { raw, ageMs } = game.observe();
    return new Error(
      `tutorial preparation failed: ${message}; state=${JSON.stringify({
        player: raw.player,
        ageMs,
        modalOpen: raw.modalOpen,
        modalInterface: raw.modalInterface,
        dialogOpen: raw.dialog.isOpen,
        nearbyNpcs: raw.nearbyNpcs.map((npc) => npc.name),
      })}`,
    );
  };
  const needsTutorial = () => {
    const o = game.observe(),
      p = o.raw.player;
    if (!o.raw.inGame || !p || o.ageMs > 3000)
      throw new Error("fresh in-game state required for tutorial preparation");
    if (![p.worldX, p.worldZ].every(Number.isFinite))
      throw new Error("invalid player coordinates during tutorial preparation");
    // Pinned content/scripts/tutorial/scripts/util.rs2 includes the underground section.
    return (
      (p.worldX >= 3053 &&
        p.worldX <= 3156 &&
        p.worldZ >= 3056 &&
        p.worldZ <= 3136) ||
      (p.worldX >= 3072 &&
        p.worldX <= 3118 &&
        p.worldZ >= 9492 &&
        p.worldZ <= 9535) ||
      (o.raw.modalOpen === true && o.raw.modalInterface === 3559)
    );
  };
  let lastMessage = "SDK returned no reason";
  for (let attempt = 0; attempt < 30; attempt++) {
    await game.ready(signal);
    if (!needsTutorial()) return;
    const result = await executionContext.run({ signal }, () =>
      bot.skipTutorial({ randomizeAppearance: true }),
    );
    lastMessage = result.message ?? "SDK returned no reason";
    // Login and teleport can publish player state before nearby NPCs arrive.
    if (!result.success && lastMessage !== "No tutorial NPC found")
      throw failure(lastMessage);
    await game.ready(signal);
    if (!needsTutorial()) return;
    if (attempt < 29) await delay(1000, undefined, { signal });
  }
  throw failure(`did not reach the mainland after 30 steps (${lastMessage})`);
}

// SDK bindings are injected here so adapter semantics can be tested without a live client.
export function sdkTransport(
  sdk: any,
  bot: any,
  executionContext: any,
  freshnessMs = 3000,
): Transport {
  let seq = 0;
  sdk.onStateUpdate(() => seq++);
  return {
    snapshot: () => {
      const state = sdk.getState();
      return {
        // The SDK adds named skill lookup through a Proxy, which structuredClone rejects.
        raw: state ? { ...state, skills: Array.from(state.skills) } : null,
        receivedAt: sdk.getStateReceivedAt() ?? 0,
        seq,
      };
    },
    close: () => sdk.disconnect(),
    dispatch: (a, _snapshot, signal) =>
      executionContext.run({ signal }, async () => {
        const s = sdk.getState() as RawState;
        try {
          signal.throwIfAborted();
          if (!s || Date.now() - (sdk.getStateReceivedAt() ?? 0) > freshnessMs)
            throw new Error("stale state");
          validate(a, s);
        } catch {
          return { success: false, phase: "validation" };
        }
        const item =
          "item" in a
            ? (a.kind === "bank_withdraw"
                ? s.bank.items
                : a.kind === "shop_buy"
                  ? s.shop.shopItems
                  : a.kind === "unequip"
                    ? s.equipment
                    : s.inventory
              ).find((x) => x.slot === a.item.slot)
            : undefined;
        const entity =
          "target" in a
            ? (a.kind === "pickup"
                ? s.groundItems
                : ["attack", "shop_open", "interact_npc"].includes(a.kind) ||
                    (a.kind === "gather" && a.skill === "fish")
                  ? s.nearbyNpcs
                  : s.nearbyLocs
              ).find(
                (x) =>
                  x.id === a.target.id &&
                  (a.target.index !== undefined
                    ? x.index === a.target.index
                    : x.x === a.target.x && x.z === a.target.z),
              )
            : undefined;
        switch (a.kind) {
          case "say":
            return sdk.sendSay(a.text);
          case "dm":
            return sdk.sendPrivateMessage(a.targetName, a.text);
          case "report_player":
            // Public on purpose: other characters must be able to see the warning.
            return sdk.sendSay(`[report] ${a.targetName}: ${a.reason}`);
          case "walk":
            return sdk.sendWalk(a.x, a.z);
          case "follow":
            return sdk.sendInteractPlayer(a.player.index, 3);
          case "stop_follow":
            return sdk.sendWalk(s.player!.worldX, s.player!.worldZ);
          case "trade_request":
            return sdk.sendTradeRequest(a.player.index);
          case "trade_offer":
            return sdk.sendOfferItem(a.item.slot, a.count);
          case "trade_accept":
            return sdk.sendAcceptTrade();
          case "trade_decline":
            return sdk.sendDeclineTrade();
          case "drop":
            return sdk.sendDropItem(a.item.slot);
          case "pickup":
            return sdk.sendPickup(a.target.x, a.target.z, a.target.id);
          case "interact_npc":
            return sdk.sendInteractNpc(a.target.index, a.option);
          case "interact_loc":
            return sdk.sendInteractLoc(
              a.target.x,
              a.target.z,
              a.target.id,
              a.option,
            );
          case "choose_dialog":
            return sdk.sendClickDialog(a.option);
          case "close_interface":
            return bot.closeInterface();
          case "bank_open":
            return bot.openBank();
          case "bank_deposit":
            return sdk.sendBankDeposit(a.item.slot, a.count);
          case "bank_withdraw":
            return sdk.sendBankWithdraw(a.item.slot, a.count);
          case "shop_open":
            return sdk.sendInteractNpc(
              a.target.index,
              entity!.optionsWithIndex!.find((o) => /trade/i.test(o.text))!
                .opIndex,
            );
          case "shop_buy":
            return sdk.sendShopBuy(a.item.slot, a.count);
          case "shop_sell":
            return sdk.sendShopSell(a.item.slot, a.count);
          case "equip":
            return sdk.sendUseItem(
              a.item.slot,
              (
                item!.optionsWithIndex as { text: string; opIndex: number }[]
              ).find((o) => /^(wear|wield|equip)$/i.test(o.text))!.opIndex,
            );
          case "unequip":
            return sdk.sendUseEquipmentItem(a.item.slot, 1);
          case "eat":
            return sdk.sendUseItem(
              a.item.slot,
              (
                item!.optionsWithIndex as { text: string; opIndex: number }[]
              ).find((o) => /^eat$/i.test(o.text))!.opIndex,
            );
          case "attack":
            return sdk.sendInteractNpc(
              a.target.index,
              entity!.optionsWithIndex!.find((o) => /^attack$/i.test(o.text))!
                .opIndex,
            );
          case "gather": {
            const bounded = AbortSignal.any([
              signal,
              AbortSignal.timeout(a.durationSeconds * 1000),
            ]);
            return executionContext.run({ signal: bounded }, async () => {
              const before = s.inventory.reduce((sum, i) => sum + i.count, 0);
              const sent =
                a.skill === "fish"
                  ? await sdk.sendInteractNpc(a.target.index, a.option)
                  : await sdk.sendInteractLoc(
                      a.target.x,
                      a.target.z,
                      a.target.id,
                      a.option,
                    );
              if (!sent.success) return sent;
              await sdk.waitForCondition(
                (state: RawState) =>
                  state.inventory.reduce((sum, i) => sum + i.count, 0) > before,
                a.durationSeconds * 1000,
              );
              return { success: true, phase: "completion" };
            });
          }
        }
      }),
  };
}
