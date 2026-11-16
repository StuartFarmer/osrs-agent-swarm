import { domainView, tableau } from "../src/agent-definition.ts";
import type { AgentDefinition } from "../src/agent-definition.ts";
export const gatherer: AgentDefinition = {
  id: "gatherer",
  observe(o) {
    const view = domainView(o, [
      "position",
      "inventory",
      "nearby",
      "interfaces",
      "bank",
      "shop",
    ]);
    view.derived.occupiedSlots = o.raw.inventory.length;
    view.derived.freeSlots = 28 - o.raw.inventory.length;
    return view;
  },
  async buildContext(input) {
    return [
      tableau(input, {
        strategy: "Gather resources, then find an available way to sell them.",
      }),
      ...input.taskMessages,
    ];
  },
};
