import { domainView, type AgentDefinition } from "../src/agent-definition.ts";

// Adapted workflow: https://github.com/MaxBittker/runebench/blob/main/shared/agents.md
const instructions = `Play through TypeScript scripts using execute_code. You control one persistent character; sdk and bot are already connected to it. Conversation history and private notes persist between tasks.
First inspect using execute_code with code "return {player: sdk.getState()?.player, inventory: sdk.getInventory()};" and world "brief".
Read sdk/API.md, search_reference in wiki/ and learnings/ when needed. Confirm method signatures rather than inventing APIs. Mining has bot.mineRock; fishing and cooking use interactNpc and useItemOnLoc.
Choose script duration for the task. There is no default script timeout; timeoutSeconds optionally sets one. Verify unfamiliar actions before repeating them.
Example: const result = await bot.chopTree(/^tree$/i); return result;
Example loop after verifying chopping: const end = Date.now() + 20000; while (Date.now() < end && sdk.getInventory().length < 27) { const r = await bot.chopTree(/^tree$/i); if (!r.success) { console.log(r); break; } } return sdk.getInventory();
bot.* high-level actions wait for effects and handle common UI/pathfinding; sdk.send* methods dispatch low-level actions. Read state inside the script, just before choosing targets. No observation stamps or action-age limits.
Return concise outcomes and use world:"none" when no observation is needed. Avoid dumping the full world repeatedly. On timeout or uncertain outcomes inspect state before sending the action again.
If blocked, inspect dialogs and game messages and check for doors. Exact names (/^tree$/i) avoid selecting tree stumps. Save useful findings and your next step with update_memory before finishing; these notes persist between tasks. Do not access other agents' files, credentials, server files or save files. Earn money through game actions only.`;

export const runebench: AgentDefinition = {
  id: "runebench",
  toolset: "sdk",
  observe(o) {
    return domainView(o, [
      "position",
      "inventory",
      "chat",
      "nearby",
      "interfaces",
      "bank",
      "shop",
    ]);
  },
  async buildContext(input) {
    return [
      {
        role: "user",
        content: `${instructions}\nObjective: ${input.objective}\n${input.instructions}\nPrivate notes: ${JSON.stringify(input.memory.read())}`,
        timestamp: Date.now(),
      },
      ...input.taskMessages,
    ];
  },
};
