import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotWorldState } from "../vendor/rs-sdk/sdk/types.ts";
import { formatObservation } from "../src/observation.ts";
import { installObservationPatch } from "../src/world-patches.ts";

const require = createRequire(import.meta.url);
const { summarizeWorldState } = require("../vendor/rs-sdk/sdk/formatter.ts");
const swing = "You swing your pick at the rock.";
const ore = "You manage to mine some copper.";
const locked = "The door is locked tight, I can't open it.";
const levelUp = "Congratulations, you just advanced a mining level.";
const message = (tick: number, text: string, sender = "") => ({
  tick, text, sender, type: sender ? 2 : 0, fromSelf: false,
});

function mine(): BotWorldState {
  const rock = { name: "Copper rock", id: 2090, level: 0, options: ["Mine", "Prospect"],
    optionsWithIndex: [{ text: "Mine", opIndex: 1 }, { text: "Prospect", opIndex: 2 }], reachable: true };
  const npc = { index: 6, id: 89, name: "Unicorn", combatLevel: 15, x: 3285, z: 3369,
    tileX: 3284, tileZ: 3368, hp: 4, maxHp: 10, distance: 2, inCombat: false,
    options: ["Attack"], optionsWithIndex: [{ opIndex: 2, text: "Attack" }] };
  return {
    tick: 100, inGame: true, player: { name: "Miner", worldX: 3284, worldZ: 3368, x: 777, z: 888,
      level: 0, combatLevel: 3, hp: 9, maxHp: 10, combat: { inCombat: false }, lifeId: 1 },
    skills: [{ name: "Mining", level: 2, baseLevel: 1, experience: 40 }],
    inventory: [{ slot: 0, id: 1265, name: "Pickaxe", count: 2, baseCost: 4, optionsWithIndex: [{ opIndex: 3, text: "Wield" }] }],
    equipment: [], nearbyPlayers: [], nearbyNpcs: [npc, { ...npc, index: 7, name: "Guide",
      options: ["Talk-to"], optionsWithIndex: [{ opIndex: 1, text: "Talk-to" }] }],
    nearbyLocs: [...Array.from({ length: 24 }, (_, i) => ({ ...rock, x: 3284 + i, z: 3368, distance: i })),
      { ...rock, name: "Bush", options: [], optionsWithIndex: [] }, { ...rock, name: "Blocked", reachable: false }],
    groundItems: [8, 1].map(distance => ({ id: 1951, name: "Berries", count: 1, x: 3284 + distance, z: 3368, distance })),
    gameMessages: [...Array.from({ length: 45 }, (_, i) => message(i, i % 9 ? swing : ore)),
      message(46, levelUp), message(47, locked), message(48, locked), message(49, "buying ore", "Trader")],
    recentDialogs: [{ text: ["obsolete dialogue"], tick: 30 }], dialog: { isOpen: false, options: [] },
    interface: { isOpen: false }, bank: { isOpen: false, items: [] }, shop: { isOpen: false },
    prayers: { activePrayers: [true, false] }, combatStyle: { currentStyle: 0, weaponName: "Pickaxe",
      styles: [{ index: 0, name: "Spike", type: "Accurate", trainsSkills: ["Attack"], damageType: "Stab" }] },
  } as unknown as BotWorldState;
}

test("mining observations keep actionable targets and remove repeated feedback", t => {
  const s = mine();
  const world = formatObservation(s);
  assert.match(world, /location \(3284, 3368\)/);
  assert.match(world, /\|Mining\|2\|40\|40\|/);
  assert.match(world, /\|Pickaxe\|—, —, Wield\|2\|8\|/);
  assert.match(world, /Current style: 0 \(Spike\), Pickaxe/);
  assert.match(world, /Active prayers: thick_skin/);
  assert.match(world, /# Entities[^#]*\|6\|Unicorn\|3284\|3368\|2\|15\|4\/10\|—, Attack\|/);
  assert.match(world, /# NPCs[^#]*Guide/);
  assert.match(world, /Locations \(nearest 10 of 24\)/);
  assert.match(world, /1951\|Berries\|3285\|3368\|1\|1\|\n\|1951\|Berries\|3292\|3368\|8/);
  assert.doesNotMatch(world, /777|Blocked|Bush|obsolete dialogue|lifeId|You swing|manage to mine|Congratulations/);
  assert.equal(world.split(locked).length - 1, 1);
  assert.match(world, /49\|Trader\|buying ore/);
  const oldBytes = Buffer.byteLength(JSON.stringify(summarizeWorldState(s, 0, { detail: "brief" })));
  const newBytes = Buffer.byteLength(world);
  t.diagnostic(`SDK brief mining fixture: ${oldBytes} bytes before, ${newBytes} bytes after`);
  assert.ok(newBytes < oldBytes);
});

test("the current dialog takes focus while chat stays visible, chronological and bounded", () => {
  const s = mine();
  s.dialog = { isOpen: true, isWaiting: false, text: "You need a Mining level of 15 to mine this rock.",
    options: [{ index: 0, text: "Continue" }], pageId: "page-2" };
  s.bank.isOpen = true;
  s.gameMessages = Array.from({ length: 31 }, (_, i) => message(i, "message " + i, "Trader"));
  s.gameMessages.push(message(32, s.dialog.text!), message(33, swing, "Trader"));
  const world = formatObservation(s);
  assert.match(world, /"state":\{"dialog":\{"type":"error".*"index":0.*"tick":100.*"pageId":"page-2"/);
  assert.equal(world.split(s.dialog.text!).length - 1, 1);
  assert.doesNotMatch(world, /"bank"|# Locations|# Inventory|obsolete dialogue|message [01]\|/);
  assert.match(world, /\|2\|Trader\|message 2\|/);
  assert.ok(world.includes(swing));
  s.dialog.isOpen = false;
  s.bank.items = [{ slot: 4, id: 995, name: "Coins", count: 350 }];
  assert.match(formatObservation(s), /"state":\{"bank":\{"items":\[\{"slot":4,"id":995/);
  for (const key of ["shop", "trade", "ge", "interface"] as const) {
    const view = formatObservation({ ...mine(), [key]: { isOpen: true, title: key } });
    assert.ok(view.includes(`"state":{"${key}":`));
    assert.doesNotMatch(view, /# Locations|# Current Stats|"isOpen"/);
  }
});

test("prepared clients publish current dialog text and cache value alongside item identity", async t => {
  const game = await mkdtemp(join(tmpdir(), "observation-client-"));
  t.after(() => rm(game, { recursive: true, force: true }));
  const dir = "server/webclient/src/bot";
  await mkdir(join(game, dir), { recursive: true });
  for (const file of ["types.ts", "StateCollector.ts"])
    await cp(join("vendor/rs-sdk", dir, file), join(game, dir, file));
  await installObservationPatch(game);
  await installObservationPatch(game);
  const source = await readFile(join(game, dir, "StateCollector.ts"), "utf8");
  assert.match(source, /text: isOpen \? c.getDialogText\(\)/);
  assert.match(source, /baseCost = obj.cost/);
  assert.match(source, /count,\s+baseCost,\s+optionsWithIndex/);
});
