import type { BotWorldState, InventoryItem, GameMessage } from "../vendor/rs-sdk/sdk/types.ts";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PRAYER_NAMES }: typeof import("../vendor/rs-sdk/sdk/types.ts") = require("../vendor/rs-sdk/sdk/types.ts");
const { redactCredentials }: typeof import("../vendor/rs-sdk/sdk/redact.ts") = require("../vendor/rs-sdk/sdk/redact.ts");

export const domains = ["position", "inventory", "chat", "nearby", "interfaces", "bank", "shop"] as const;
export type Domain = typeof domains[number];
type Cell = string | number | null | undefined;

function table(title: string, headers: string[], rows: Cell[][]) {
  if (!rows.length) return `# ${title}\nNone`;
  const line = (cells: Cell[]) => "|" + cells.map(c => String(c ?? "").replaceAll("|", "\\|").replace(/[\r\n]+/g, " ")).join("|") + "|";
  return [`# ${title}`, line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n");
}

function options(item: { optionsWithIndex?: { opIndex: number; text: string }[]; options?: string[] }) {
  if (!item.optionsWithIndex?.length) return item.options ?? [];
  const slots: string[] = [];
  for (const { opIndex, text } of item.optionsWithIndex) slots[opIndex - 1] = text;
  return Array.from(slots, text => text ?? "—");
}

const hp = (p: { hp?: number | null; maxHp?: number | null }) =>
  p.hp != null && p.maxHp != null ? `${p.hp}/${p.maxHp}` : undefined;

// The pinned world uses level/10 and publishes whole XP to the client.
const nextXp: number[] = [];
for (let level = 1, points = 0; level < 99; level++) {
  points += Math.floor(level + 300 * 2 ** (level / 10));
  nextXp[level] = Math.floor(points / 4);
}

function items(title: string, list: (InventoryItem & { baseCost?: number })[]) {
  return table(title, ["Slot", "ID", "Item", "Options", "Count", "Base value (stack)"], list.map(i =>
    [i.slot, i.id, i.name, options(i).join(", "), i.count, i.id === 995 ? i.count : i.baseCost == null ? null : i.baseCost * i.count]));
}

const clean = (s: string) => s.replace(/@\w{3}@/g, "").trim();
const routine = /^You (?:swing your pick(?:axe)? at the rock|manage to mine some [\w -]+|swing your axe at the tree|get some (?:[\w -]+ )?logs|cast out your (?:line|net)|attempt to catch a fish)[.!]*$/i;
const levelUp = /congratulations[,! ]+you (?:just |have )?advanced (?:a|an|your) .+? level/i;

function focus(s: BotWorldState, allowed: readonly Domain[]) {
  if (allowed.includes("interfaces") && s.dialog?.isOpen) {
    const d = s.dialog;
    const text = clean(d.text ?? "");
    return { dialog: {
      type: levelUp.test(text) ? "level-up" : /\byou need\b|\bcan't\b|\bcannot\b/i.test(text) ? "error" : "dialog",
      text, actions: (d.options ?? []).map(({ index, text }) => ({ index, text })),
      tick: s.tick, pageId: d.pageId, waiting: d.isWaiting || undefined,
    } };
  }
  const windows = [
    ["trade", s.trade, "interfaces"], ["ge", s.ge, "interfaces"], ["shop", s.shop, "shop"],
    ["bank", s.bank, "bank"], ["interface", s.interface, "interfaces"],
  ] as const;
  for (const [name, window, domain] of windows) {
    if (!window?.isOpen) continue;
    if (!allowed.includes(domain)) return null;
    const { isOpen, ...contents } = window;
    return { [name]: contents };
  }
  if (allowed.includes("interfaces") && s.modalOpen) return { interface: { interfaceId: s.modalInterface } };
  return null;
}

function messages(list: GameMessage[], dialogText: string) {
  const seen = new Set<string>();
  const rows: Cell[][] = [];
  for (let i = list.length - 1; i >= 0 && rows.length < 30; i--) {
    const m = list[i];
    const text = clean(m.text);
    if (!text) continue;
    if (!m.sender) {
      if (routine.test(text)) continue;
      if (levelUp.test(text) || dialogText.includes(text) || seen.has(text)) continue;
      seen.add(text);
    }
    const sender = m.type === 6 ? `PM to ${m.sender}` : [3, 7].includes(m.type) ? `PM from ${m.sender}` : m.sender;
    rows.push([m.tick, sender || "Notification", text]);
  }
  return table("Messages", ["Tick", "Sender", "Message"], rows.reverse());
}

function nearby(s: BotWorldState, limit: number, stamped: boolean) {
  const sections: string[] = [];
  function list<T extends { reachable?: boolean; distance: number }>(
    title: string, headers: string[], source: T[], row: (t: T) => Cell[],
  ) {
    const targets = source.filter(t => t.reachable !== false).sort((a, b) => a.distance - b.distance);
    if (!targets.length) return;
    const heading = targets.length > limit ? `${title} (nearest ${limit} of ${targets.length})` : title;
    sections.push(table(heading, headers, targets.slice(0, limit).map(row)));
  }
  const actors = (s.nearbyNpcs ?? []).map(n => ({ ...n, ops: options(n) })).filter(n => n.ops.length);
  const header = ["Index", ...(stamped ? ["ID"] : []), "Name", "X", "Z", "Distance", "Combat level", "HP", "Options (1-based)"];
  for (const [name, hostile] of [["NPCs", false], ["Entities", true]] as const) {
    list(name, header, actors.filter(n => n.ops.some(o => /^attack$/i.test(o)) === hostile),
      n => [n.index, ...(stamped ? [n.id] : []), n.name, n.tileX ?? n.x, n.tileZ ?? n.z, n.distance, n.combatLevel || null, hp(n), n.ops.join(", ")]);
  }
  list("Players", ["Index", "Name", "X", "Z", "Distance", "Combat level", "HP", "Weapon"], s.nearbyPlayers ?? [],
    p => [p.index, p.name, p.x, p.z, p.distance, p.combatLevel, hp(p), p.weaponName]);
  const locs = (s.nearbyLocs ?? []).filter(l => options(l).length);
  const upstairs = locs.some(l => l.reachable !== false && l.level);
  list("Locations", ["ID", "Name", "X", "Z", ...(upstairs ? ["Level"] : []), "Distance", "Options (1-based)"], locs,
    l => [l.id, l.name, l.x, l.z, ...(upstairs ? [l.level || null] : []), l.distance, options(l).join(", ")]);
  list("Ground items", ["ID", "Item", "X", "Z", "Distance", "Count"], s.groundItems ?? [],
    i => [i.id, i.name, i.x, i.z, i.distance, i.count]);
  return sections;
}

export function formatObservation(s: BotWorldState, allowed: readonly Domain[] = domains, options: { nearbyLimit?: number; chat?: GameMessage[]; stamped?: boolean } = {}) {
  const sections: string[] = [];
  const p = s.player;
  const state = focus(s, allowed);
  if (allowed.includes("position")) {
    sections.push([`# Overview\nCurrent tick: ${s.tick}`, p ? [
      p.name, p.combatLevel != null && `combat level ${p.combatLevel}`, hp(p) && `HP ${hp(p)}`,
      `location (${p.worldX}, ${p.worldZ})`, p.level && `plane ${p.level}`,
      p.combat?.inCombat && (p.combat.targetType === "none" ? "in combat" : `fighting ${p.combat.targetType} ${p.combat.targetIndex}`),
      p.runEnergy != null && `run energy ${p.runEnergy}`,
    ].filter(Boolean).join(" · ") : "Character offline"].join("\n"));
  }
  if (allowed.includes("interfaces") || state) {
    sections.push("# Current State\n" + JSON.stringify({ state: state ?? "world" }));
  }
  if (allowed.includes("chat")) sections.push(messages(options.chat ?? s.gameMessages ?? [], state?.dialog?.text ?? ""));
  if (allowed.includes("inventory") && (!state || !("dialog" in state))) {
    sections.push(items("Inventory", s.inventory ?? []));
    if (!state) sections.push(items("Equipment", s.equipment ?? []));
  }
  if (!state && allowed.includes("position")) {
    const skills = (s.skills ?? []).filter(k => !/^Stat\d+$/i.test(k.name));
    sections.push(table("Current Stats", ["Skill", "Level", "XP", "XP to next level"], skills.map(k => {
      const base = k.baseLevel ?? k.level;
      return [k.name, k.level, k.experience, nextXp[base] == null ? null : Math.max(0, nextXp[base] - k.experience)];
    })));
    const style = s.combatStyle;
    if (style) {
      sections.push(table("Combat Styles", ["Index", "Style", "Type", "Skill trained", "Damage type"], style.styles.map(
        o => [o.index, o.name, o.type, o.trainsSkills.join(", "), o.damageType])) +
        `\nCurrent style: ${style.currentStyle} (${style.styles.find(o => o.index === style.currentStyle)?.name ?? "unknown"}), ${style.weaponName}`);
    }
    if (s.prayers) sections.push("Active prayers: " + (PRAYER_NAMES.filter((_, i) => s.prayers.activePrayers[i]).join(", ") || "none"));
  }
  if (!state && allowed.includes("nearby")) sections.push(...nearby(s, options.nearbyLimit ?? 10, options.stamped ?? false));
  return redactCredentials(sections.join("\n\n"));
}
