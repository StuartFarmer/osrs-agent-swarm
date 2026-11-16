import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { GameClient, GameAction } from "./game.ts";
import type { Store } from "./store.ts";
import type { Trace } from "./trace.ts";
import type { AgentKey } from "./types.ts";
import { project, historyFor, json } from "./agent-definition.ts";
import type { AgentDefinition } from "./agent-definition.ts";
const obj = (fields: Record<string, TSchema>) =>
  Type.Object(fields, { additionalProperties: false });
const int = (min = 0, max = 2147483647) =>
  Type.Integer({ minimum: min, maximum: max });
const text = (max = 400) => Type.String({ minLength: 1, maxLength: max });
const stamp = obj({
  sessionEpoch: text(64),
  observationSeq: int(),
  observedAt: Type.Number({ minimum: 0 }),
});
const item = obj({ slot: int(0, 1000), id: int() });
const player = obj({ index: int(0, 2047), name: text(12) });
const target = obj({
  id: int(),
  x: int(0, 16383),
  z: int(0, 16383),
  index: Type.Optional(int()),
  level: Type.Optional(int(0, 3)),
});
const offer = Type.Array(obj({ id: int(), count: int(1) }), { maxItems: 28 });
const trade = { partner: text(12), give: offer, receive: offer };
const memory = obj({
  plan: Type.Array(Type.String()),
  beliefs: Type.Array(Type.String()),
  relationships: Type.Record(Type.String(), Type.String()),
  nextAction: Type.String(),
});
const actions: Record<
  string,
  { fields: Record<string, TSchema>; description: string }
> = {
  say: { fields: { text: text() }, description: "Speak publicly." },
  dm: {
    fields: { targetName: text(12), text: text() },
    description: "Send a private in-game message.",
  },
  walk: {
    fields: { x: int(0, 16383), z: int(0, 16383) },
    description: "Walk to coordinates.",
  },
  follow: {
    fields: { player },
    description: "Follow the exact nearby player.",
  },
  stop_follow: {
    fields: {},
    description: "Stop following by walking to your current tile.",
  },
  trade_request: {
    fields: { player },
    description: "Request a trade with a nearby player.",
  },
  trade_offer: {
    fields: { ...trade, item, count: int(1) },
    description:
      "Offer items only if the existing partner and complete offers still match.",
  },
  trade_accept: {
    fields: {
      ...trade,
      screen: Type.Union([Type.Literal("offer"), Type.Literal("confirm")]),
    },
    description:
      "Accept ONE trade screen only if the partner and complete offers still match. Confirmation needs another checked call.",
  },
  trade_decline: { fields: {}, description: "Decline the current trade." },
  pickup: {
    fields: { target },
    description: "Pick up the exact observed ground item.",
  },
  drop: {
    fields: { item, count: int(1) },
    description: "Drop an exact item and count.",
  },
  interact_npc: {
    fields: { target, option: int(1, 5) },
    description: "Use an NPC option published in the observation.",
  },
  interact_loc: {
    fields: { target, option: int(1, 5) },
    description:
      "Use an object option published in the observation; include its level.",
  },
  choose_dialog: {
    fields: { pageId: text(200), option: int(0, 10) },
    description: "Choose an option on the exact observed dialogue page.",
  },
  close_interface: { fields: {}, description: "Close a blocking interface." },
  bank_open: { fields: {}, description: "Find and open a nearby bank." },
  bank_deposit: {
    fields: { item, count: int(1) },
    description: "Deposit items while the bank is open.",
  },
  bank_withdraw: {
    fields: { item, count: int(1) },
    description: "Withdraw an exact observed bank item.",
  },
  shop_open: {
    fields: { target },
    description: "Open a shop using a nearby NPC.",
  },
  shop_buy: {
    fields: { item, count: int(1) },
    description: "Buy an exact shop item.",
  },
  shop_sell: {
    fields: { item, count: int(1) },
    description: "Sell an exact inventory item.",
  },
  equip: { fields: { item }, description: "Equip an exact inventory item." },
  unequip: { fields: { item }, description: "Unequip an exact equipped item." },
  eat: { fields: { item }, description: "Eat an exact inventory item." },
  attack: { fields: { target }, description: "Attack an exact nearby NPC." },
  gather: {
    fields: {
      skill: Type.Union(["chop", "mine", "fish"].map((s) => Type.Literal(s))),
      target,
      option: int(1, 5),
      durationSeconds: Type.Number({ exclusiveMinimum: 0, maximum: 30 }),
    },
    description: "Start a bounded gathering action using a published option.",
  },
};
export function createTools(
  key: AgentKey,
  game: GameClient,
  store: Store,
  trace: Trace,
  definition: AgentDefinition,
): AgentTool[] {
  function tool(
    name: string,
    description: string,
    parameters: TSchema,
    execute: (args: any, signal: AbortSignal) => Promise<unknown>,
  ): AgentTool {
    return {
      name,
      label: name,
      description,
      parameters,
      async execute(_id, args, signal) {
        if (!Value.Check(parameters, args))
          throw new Error("invalid tool arguments");
        const value = await execute(
          args,
          signal ?? new AbortController().signal,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(value) }],
          details: {},
        };
      },
    };
  }
  const read = [
    tool(
      "get_state",
      "Read fresh observations allowed by your observation policy.",
      obj({}),
      async () => project(definition, game.observe()),
    ),
    tool(
      "read_memory",
      "Read your private revisioned memory.",
      obj({}),
      async () => store.readMemory(key),
    ),
    tool(
      "update_memory",
      "Replace your private memory at the expected revision.",
      obj({ expectedRevision: int(), value: memory }),
      async (a) => {
        const m = store.updateMemory(key, a.expectedRevision, a.value, "agent");
        await trace.flush(key);
        return m;
      },
    ),
    tool(
      "search_events",
      "Search your private safe memory/action history.",
      obj({ query: Type.String({ maxLength: 400 }), limit: int(1, 50) }),
      async (a) => historyFor(key, store, a.query, a.limit),
    ),
  ];
  return [
    ...read,
    ...Object.entries(actions).map(([name, { fields, description }]) =>
      tool(name, description, obj({ stamp, ...fields }), async (a, signal) => {
        signal.throwIfAborted();
        trace.check();
        const id = randomUUID(),
          action = { ...a, kind: name } as GameAction;
        store.beginAction(key, id, json(action));
        await trace.flush(key);
        const outcome = await game.execute(action, signal);
        store.endAction(key, id, outcome);
        await trace.flush(key);
        // The SDK's free-form messages/evidence may contain observations from excluded domains.
        return {
          actionId: id,
          status: outcome.status,
          observation: project(definition, game.observe()),
        };
      }),
    ),
  ];
}
