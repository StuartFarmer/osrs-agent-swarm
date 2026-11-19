import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function patch(file: string, before: string, after: string) {
  const source = await readFile(file, "utf8");
  if (source.includes(after)) return;
  if (source.split(before).length !== 2)
    throw new Error("Pinned game patch mismatch in " + file);
  await writeFile(file, source.replace(before, after));
}

// Both Lite and browser clients use this collector. Read text from the open
// page itself: the history can still point to an earlier page of the same NPC.
export async function installObservationPatch(game: string) {
  const bot = join(game, "server/webclient/src/bot");
  const collector = join(bot, "StateCollector.ts");
  await patch(join(bot, "types.ts"), "export interface DialogState {", "export interface DialogState {\n    text?: string;");
  await patch(join(bot, "types.ts"), "export interface InventoryItem {", "export interface InventoryItem {\n    baseCost?: number;");
  await patch(collector, "return { isOpen, options, isWaiting, pageId:", "return { isOpen, options, isWaiting, text: isOpen ? c.getDialogText().join(' ') : undefined, pageId:");
  await patch(collector, "const optionsWithIndex: InventoryItemOption[] = [];", "let baseCost: number | undefined;\n                    const optionsWithIndex: InventoryItemOption[] = [];");
  await patch(collector, "// Get inventory options (iop)", "baseCost = obj.cost;\n                        // Get inventory options (iop)");
  await patch(collector, "count,\n                        optionsWithIndex\n", "count,\n                        baseCost,\n                        optionsWithIndex\n");
}

export async function installCharacterPatches(game: string) {
  const client = join(game, "server/webclient/src/lite/actions.ts");
  await patch(
    client,
    "import IfType,",
    "import IdkType from '#/config/IdkType.js';\nimport IfType,",
  );
  await patch(
    client,
    "c.designKits[part] = 0;",
    `const target = part + (c.designGender ? 0 : 7);
        const valid = IdkType.list.flatMap((kit, id) => !kit.disable && kit.part === target ? [id] : []);
        c.designKits[part] = valid.length ? valid[Math.floor(Math.random() * valid.length)] : -1;`,
  );
  await patch(
    client,
    "(Math.random() * 10) | 0",
    "Math.floor(Math.random() * [12, 16, 16, 6, 8][i])",
  );
  const engine = join(game, "server/engine/src/engine");
  const ops = join(engine, "script/handlers/PlayerOps.ts");
  await patch(
    ops,
    "import IdkType",
    "import { recordDeath } from '#/web/engine-deaths.mjs';\nimport IdkType",
  );
  await patch(
    ops,
    "state.activePlayer.messageGame(message);",
    `if (message === 'Oh dear you are dead!' && ['death.rs2', 'castlewars_death.rs2', 'duel_arena_finish.rs2'].includes(state.script.fileName))
            recordDeath(state.activePlayer.username, World.currentTick, state.script.name);
        state.activePlayer.messageGame(message);`,
  );
  const world = join(engine, "World.ts");
  const anchor = "if (isClientConnected(player) && player.decodeIn())";
  await patch(
    world,
    anchor,
    "if (!swarmDeaths()?.has(player.username) && isClientConnected(player) && player.decodeIn())",
  );
  await patch(
    world,
    "import Environment from",
    "import { deaths as swarmDeaths } from '#/web/engine-deaths.mjs';\nimport Environment from",
  );
}
