import type { Store } from "./store.ts";
import type { AgentKey, JsonValue } from "./types.ts";
import type { Observation, GameAction, Item, RawState } from "./game.ts";
import { project, json } from "./agent-definition.ts";
import type { AgentDefinition } from "./agent-definition.ts";

const totals = (items: Pick<Item, "id" | "count">[]) => {
  const result: Record<string, number> = {};
  for (const item of items)
    result[item.id] = (result[item.id] ?? 0) + item.count;
  return result;
};
type Baseline = {
  inventory: Record<string, number>;
  equipment: Record<string, number>;
  bank: Record<string, number>;
  tick: number;
  position: { x: number; z: number } | null;
};
type Intent = { action: GameAction; before: Baseline };
export function actionIntent(action: GameAction, o: Observation): JsonValue {
  return json({
    action,
    before: {
      inventory: totals(o.raw.inventory),
      equipment: totals(o.raw.equipment),
      bank: totals(o.raw.bank.items),
      tick: o.clientTick,
      position: o.raw.player
        ? { x: o.raw.player.worldX, z: o.raw.player.worldZ }
        : null,
    },
  });
}
export function pendingView(
  key: AgentKey,
  store: Store,
  offset = 0,
  limit = 20,
) {
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new Error("invalid pending action page");
  const pending = store.pendingActions(key);
  return {
    total: pending.length,
    offset,
    entries: pending.slice(offset, offset + limit).map((x) => {
      const i = x.intent as unknown as Partial<Intent> & { kind?: string };
      return {
        actionId: x.actionId,
        kind: i.action?.kind ?? i.kind ?? "unknown",
        status: x.outcome?.status ?? "unknown",
      };
    }),
  };
}
function safeIntent(
  action: GameAction,
  definition: AgentDefinition,
  o: Observation,
): JsonValue {
  const domains = project(definition, o).domains;
  const result: Record<string, JsonValue> = { kind: action.kind };
  const copy = (fields: string[]) => {
    for (const field of fields)
      if (field in action) result[field] = json((action as any)[field]);
  };
  if (domains.chat !== undefined) copy(["text", "targetName", "reason"]);
  if (domains.position !== undefined) copy(["x", "z"]);
  if (domains.nearby !== undefined)
    copy(["player", "target", "option", "skill", "durationSeconds"]);
  if (domains.interfaces !== undefined)
    copy(["partner", "screen", "give", "receive", "pageId"]);
  const itemDomain =
    action.kind === "bank_withdraw"
      ? "bank"
      : action.kind === "shop_buy"
        ? "shop"
        : "inventory";
  if (domains[itemDomain] !== undefined) copy(["item", "count"]);
  return result;
}
function observedEffect(intent: Intent, s: RawState): boolean {
  const { action: a, before: b } = intent;
  if (!a || !b) return false;
  const inventory = totals(s.inventory),
    equipment = totals(s.equipment),
    bank = totals(s.bank.items);
  const difference = (id: number) =>
    (inventory[id] ?? 0) - (b.inventory[id] ?? 0);
  switch (a.kind) {
    case "walk":
      return s.player?.worldX === a.x && s.player?.worldZ === a.z;
    case "stop_follow":
      return false; // No authoritative following-state telemetry.
    case "drop":
      return difference(a.item.id) === -a.count;
    case "pickup":
      return difference(a.target.id) > 0;
    case "eat":
      return difference(a.item.id) === -1;
    case "equip":
      return (
        (equipment[a.item.id] ?? 0) > (b.equipment[a.item.id] ?? 0) &&
        difference(a.item.id) < 0
      );
    case "unequip":
      return (
        (equipment[a.item.id] ?? 0) < (b.equipment[a.item.id] ?? 0) &&
        difference(a.item.id) > 0
      );
    case "bank_deposit":
      return (
        s.bank.isOpen &&
        difference(a.item.id) === -a.count &&
        (bank[a.item.id] ?? 0) - (b.bank[a.item.id] ?? 0) === a.count
      );
    case "bank_withdraw":
      return (
        s.bank.isOpen &&
        difference(a.item.id) === a.count &&
        (bank[a.item.id] ?? 0) - (b.bank[a.item.id] ?? 0) === -a.count
      );
    case "shop_buy":
      return difference(a.item.id) === a.count;
    case "shop_sell":
      return difference(a.item.id) === -a.count;
    case "bank_open":
      return s.bank.isOpen;
    case "shop_open":
      return s.shop.isOpen;
    case "say":
    case "dm":
      return s.gameMessages.some((value) => {
        const m = value as {
          text?: string;
          tick?: number;
          type?: number;
          sender?: string;
        };
        return (
          (m.tick ?? -1) > b.tick &&
          m.text?.toLowerCase() === a.text.toLowerCase() &&
          (a.kind === "dm"
            ? m.type === 6
            : [1, 2].includes(m.type ?? -1) &&
              m.sender?.toLowerCase() === s.player?.name.toLowerCase())
        );
      });
    case "trade_accept": {
      if (a.screen === "offer")
        return (
          s.trade?.screen === "confirm" &&
          s.trade.partner === a.partner &&
          JSON.stringify(totals(s.trade.myOffer)) ===
            JSON.stringify(totals(a.give)) &&
          JSON.stringify(totals(s.trade.theirOffer)) ===
            JSON.stringify(totals(a.receive))
        );
      if (s.trade?.isOpen) return false;
      const delta: Record<string, number> = {};
      for (const x of a.give) delta[x.id] = (delta[x.id] ?? 0) - x.count;
      for (const x of a.receive) delta[x.id] = (delta[x.id] ?? 0) + x.count;
      return (
        Object.values(delta).some((n) => n !== 0) &&
        Object.entries(delta).every(([id, n]) => difference(Number(id)) === n)
      );
    }
    default:
      return false;
  }
}
export function inspectAction(
  key: AgentKey,
  id: string,
  store: Store,
  definition: AgentDefinition,
  o: Observation,
) {
  if (o.ageMs > 3000 || Date.now() - o.stamp.observedAt > 3000)
    throw new Error("fresh state required for reconciliation");
  const record = store.readAction(key, id);
  if (!record) throw new Error("unknown action");
  const intent = record.intent as unknown as Intent;
  let outcome = record.outcome;
  if (
    !["failed", "completed"].includes(outcome?.status ?? "") &&
    observedEffect(intent, o.raw)
  ) {
    outcome = {
      status: "completed",
      message: "Expected postcondition observed; no action was replayed.",
      evidence: json({
        basis: "observed_postcondition_not_causal_proof",
        observedAt: o.stamp.observedAt,
        clientTick: o.clientTick,
        inventory: totals(o.raw.inventory),
        equipment: totals(o.raw.equipment),
        bank: totals(o.raw.bank.items),
        player: o.raw.player,
        trade: o.raw.trade,
      }),
    };
    store.endAction(key, id, outcome);
  }
  return {
    actionId: id,
    status: outcome?.status ?? "unknown",
    intent: intent.action
      ? safeIntent(intent.action, definition, o)
      : { kind: "legacy intent; operator inspection required" },
  };
}
