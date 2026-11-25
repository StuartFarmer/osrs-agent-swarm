import { domainView, renderView, type AgentDefinition } from "../src/agent-definition.ts";

// Adapted workflow: https://github.com/MaxBittker/runebench/blob/main/shared/agents.md
const instructions = `Play through TypeScript scripts using execute_code. You control one persistent character; sdk and bot are already connected to it. Conversation history and private notes persist between tasks.
Maximize local net liquidation gain: increase your coins plus what other players' funded GE bids can pay for your holdings after local seller tax. Shops, direct trades and paid services can earn coins too. Local prices and demand can change.
Choose your next task from your live state, opportunities and prior attempts. Explore, trade, teach or specialize as you find useful. Check read_skills for relevant routines. Test a hypothesis, check item/coin/XP changes or trade receipts, repair a failed approach, and use save_skill for reusable code with its prerequisites and evidence. Invoke a saved routine with execute_code({skill, input}). Its code receives input and the existing sdk and bot. Read sdk/MARKET.md for the local exchange.
Read sdk/API.md, search_reference in wiki/ and learnings/ when needed. Confirm method signatures rather than inventing APIs. Mining has bot.mineRock; fishing and cooking use interactNpc and useItemOnLoc.
Choose script duration for the task. There is no default script timeout; timeoutSeconds optionally sets one. Verify unfamiliar actions before repeating them.
Example: const result = await bot.chopTree(/^tree$/i); return result;
Example loop after verifying chopping: const end = Date.now() + 20000; while (Date.now() < end && sdk.getInventory().length < 27) { const r = await bot.chopTree(/^tree$/i); if (!r.success) { console.log(r); break; } } return sdk.getInventory();
bot.* high-level actions wait for effects and handle common UI/pathfinding; sdk.send* methods dispatch low-level actions. Read state inside the script, just before choosing targets. No observation stamps or action-age limits.
Return concise outcomes and use world:"none" when no observation is needed. The live overview includes chat and the current interface. Use a world observation for nearby targets. On timeout or uncertain outcomes inspect state before sending the action again.
If blocked, inspect dialogs and game messages and check for doors. Exact names (/^tree$/i) avoid selecting tree stumps. Save useful findings and your next step with update_memory before finishing; these notes persist between tasks. Do not access other agents' files, credentials, server files or save files. Earn money through game actions only.`;

export const runebench: AgentDefinition = {
  id: "runebench",
  toolset: "sdk",
  observe(o) {
    return domainView(o, [
      "position",
      "inventory",
      "chat",
      "interfaces",
      "bank",
      "shop",
    ]);
  },
  async buildContext(input) {
    return [
      {
        role: "user",
        content: `${instructions}\nObjective: ${input.objective}\n${input.instructions}`,
        timestamp: input.taskMessages[0]?.timestamp ?? 0,
      },
      ...input.taskMessages,
      {
        role: "user",
        content: `Private notes: ${JSON.stringify(input.memory.read())}\nLatest character observation:\n${renderView(input.view, false)}`,
        timestamp: input.view.stamp.observedAt,
      },
    ];
  },
};
