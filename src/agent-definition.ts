import type { Message } from "@earendil-works/pi-ai";
import type { Observation, Stamp } from "./game.ts";
import type { Store } from "./store.ts";
import type { AgentKey, JsonValue, MemoryRevision, Profile } from "./types.ts";
import { formatObservation, type Domain } from "./observation.ts";
import type { BotWorldState } from "../vendor/rs-sdk/sdk/types.ts";
export type { Domain } from "./observation.ts";
export type AgentView = {
  stamp: Stamp;
  domains: Domain[];
  observation: string;
  derived: Record<string, JsonValue>;
};
export type ContextInput = {
  view: AgentView;
  memory: { read(): MemoryRevision };
  history: { search(query: string, limit?: number): JsonValue[] };
  objective: string;
  instructions: string;
  taskMessages: Message[];
};
export type AgentDefinition = {
  id: string;
  toolset?: "sdk";
  observe(raw: Readonly<Observation>): AgentView;
  buildContext(input: ContextInput): Promise<Message[]>;
};
export function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null));
}
export function domainView(o: Observation, domains: Domain[]): AgentView {
  return {
    stamp: o.stamp,
    domains,
    observation: formatObservation(o.raw as unknown as BotWorldState, domains, { nearbyLimit: Infinity, stamped: true }),
    derived: {},
  };
}
export function renderView(view: AgentView, stamped = true): string {
  return [
    view.observation,
    stamped && "Action stamp: " + JSON.stringify(view.stamp),
    Object.keys(view.derived).length > 0 && JSON.stringify(view.derived),
  ].filter(Boolean).join("\n");
}
export function project(
  definition: AgentDefinition,
  observation: Observation,
): AgentView {
  return structuredClone(definition.observe(structuredClone(observation)));
}
// Operator events contain raw inputs; only these deliberately reduced records reach an agent.
export function historyFor(
  key: AgentKey,
  store: Store,
  query: string,
  limit = 50,
): JsonValue[] {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    typeof query !== "string" ||
    query.length > 400
  )
    throw new Error("invalid history query");
  let after = 0;
  const matches: JsonValue[] = [];
  for (;;) {
    const events = store.events(key, after, 1000);
    if (!events.length) break;
    for (const e of events) {
      let safe: JsonValue | undefined;
      if (e.type === "memory_updated")
        safe = { type: e.type, time: e.time, data: e.data };
      if (e.type === "action_outcome") {
        const d = e.data as { status: string };
        safe = {
          type: e.type,
          time: e.time,
          actionId: e.actionId ?? "",
          status: d.status,
        };
      }
      if (
        safe &&
        JSON.stringify(safe).toLowerCase().includes(query.toLowerCase())
      ) {
        matches.push(safe);
        if (matches.length > limit) matches.shift();
      }
    }
    after = events.at(-1)!.seq;
  }
  return matches;
}
export function contextInput(
  definition: AgentDefinition,
  o: Observation,
  key: AgentKey,
  store: Store,
  profile: Profile,
  taskMessages: Message[],
): ContextInput {
  return {
    view: project(definition, o),
    memory: { read: () => store.readMemory(key) },
    history: { search: (q, n) => historyFor(key, store, q, n) },
    objective: profile.objective,
    instructions: profile.instructions,
    taskMessages: structuredClone(taskMessages),
  };
}
export function tableau(
  input: ContextInput,
  extra: Record<string, JsonValue> = {},
): Message {
  return {
    role: "user",
    content:
      "<live-state>\n" +
      JSON.stringify({
        objective: input.objective,
        instructions: input.instructions,
        memory: input.memory.read(),
        ...extra,
      }) +
      "\n" + renderView(input.view) + "\n</live-state>",
    timestamp: Date.now(),
  };
}
