import { domainView, tableau } from "../src/agent-definition.ts";
import type { AgentDefinition } from "../src/agent-definition.ts";

// Shared definition for archetype-driven agents: every profile sees the full
// observable state and can use the full toolset. Profiles differ only by
// their objective and instructions, never by capability.
export const general: AgentDefinition = {
  id: "general",
  observe(o) {
    const view = domainView(o, [
      "position",
      "inventory",
      "chat",
      "nearby",
      "interfaces",
      "bank",
      "shop",
    ]);
    view.derived.liquidCoins = o.raw.inventory
      .filter((i) => i.id === 995)
      .reduce((sum, i) => sum + i.count, 0);
    view.derived.occupiedSlots = o.raw.inventory.length;
    view.derived.freeSlots = 28 - o.raw.inventory.length;
    return view;
  },
  async buildContext(input) {
    const outcomes = input.history.search("action_outcome", 10);
    return [
      tableau(input, { recentOutcomes: outcomes }),
      ...input.taskMessages,
    ];
  },
};
