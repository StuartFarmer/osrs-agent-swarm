import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Store, type EventInput } from "./store.ts";
import type { AgentEntry, AgentKey, Experiment } from "./types.ts";
import type { Account } from "./browser.ts";
import type { WealthSnapshot } from "./liquidation.ts";
import { identifier } from "./config.ts";

export type Life = {
  slot: string;
  id: string;
  generation: number;
  lessons: string[];
};
type Candidate = { id: string; wealth: number; generation: number };

export function population(founders: AgentEntry[], store?: Store): Life[] {
  const slots = new Map(
    founders.map((a) => [
      a.id,
      { slot: a.id, id: a.id, generation: 0, lessons: [] as string[] },
    ]),
  );
  for (const row of store?.db
    .prepare(
      "SELECT value FROM events WHERE json_extract(value,'$.type')='birth' ORDER BY seq",
    )
    .all() ?? []) {
    const { agentId, data } = JSON.parse(String(row.value));
    slots.set(data.slot, {
      slot: data.slot,
      id: agentId,
      generation: data.generation,
      lessons: data.lessons,
    });
  }
  return [...slots.values()];
}

export function rosterForResume(
  experiment: Experiment,
  runId?: string,
  root = process.cwd(),
) {
  if (!experiment.permadeath || !runId) return experiment.agents;
  const db = join(root, "runs", identifier(runId), "state.sqlite");
  if (!existsSync(db)) return experiment.agents;
  const store = new Store(db);
  try {
    return entriesFor(experiment, population(experiment.agents, store));
  } finally {
    store.close();
  }
}

export function entriesFor(experiment: Experiment, lives: Life[]) {
  return lives.map((life) => ({
    ...experiment.agents.find((a) => a.id === life.slot)!,
    id: life.id,
  }));
}

export function chooseParents(candidates: Candidate[], random = Math.random) {
  if (candidates.length < 2)
    throw new Error("Fewer than two living parents remain");
  const pool = [...candidates];
  return Array.from({ length: 2 }, () => {
    const total = pool.reduce((n, p) => n + p.wealth, 0);
    let roll = random() * (total || pool.length);
    const index = pool.findIndex((p) => (roll -= total ? p.wealth : 1) < 0);
    const probability = total ? pool[index].wealth / total : 1 / pool.length;
    return { ...pool.splice(index, 1)[0], probability };
  });
}

export function replaceDeaths(
  store: Store,
  key: (id: string) => AgentKey,
  lives: Life[],
  accounts: Account[],
  snapshot: WealthSnapshot,
  founderStart: number,
) {
  if (!snapshot.deaths)
    throw new Error(
      "Start the world with the permadeath experiment before running it",
    );
  const names = new Map(accounts.map((a) => [a.agentId, a.username]));
  const dead = lives.filter((life) => snapshot.deaths![names.get(life.id)!]);
  if (!dead.length) return [];
  const pool = lives
    .filter((life) => !dead.includes(life))
    .map((life) => {
      const wealth = snapshot.players[names.get(life.id)!]?.wealth;
      if (wealth === undefined)
        throw new Error("Missing parent wealth for " + life.id);
      return { id: life.id, wealth, generation: life.generation };
    });
  const batch: { key: AgentKey; event: EventInput }[] = [];
  const children: Life[] = [];
  for (const life of dead) {
    const death = snapshot.deaths[names.get(life.id)!];
    const k = key(life.id);
    const born =
      life.generation === 0
        ? founderStart
        : Date.parse(
            String(
              store.db
                .prepare(
                  "SELECT json_extract(value,'$.time') AS born FROM events WHERE scope=? AND json_extract(value,'$.type')='birth'",
                )
                .get(JSON.stringify([k.runId, k.worldId, k.agentId]))!.born,
            ),
          );
    batch.push({
      key: k,
      event: {
        type: "death",
        data: {
          ...death,
          lifespanMs: Math.max(0, death.time - born),
          selectionTick: snapshot.tick,
          slot: life.slot,
        },
      },
    });
    if (pool.length < 2) continue;
    const parents = chooseParents(pool);
    const id = "child-" + randomUUID();
    const child = {
      slot: life.slot,
      id,
      generation: 1 + Math.max(...parents.map((p) => p.generation)),
      lessons: [] as string[],
    };
    const inherited: {
      parent: string;
      revision: number;
      name?: string;
      lesson?: string;
    }[] = [];
    const used = new Set<string>();
    for (const parent of parents) {
      const parentKey = key(parent.id);
      const skills = store
        .savedSkills(parentKey)
        .filter((s) => !used.has(s.name));
      if (skills.length) {
        const { name } = skills[Math.floor(Math.random() * skills.length)];
        const skill = store.savedSkills(parentKey, name)[0];
        used.add(name);
        inherited.push({ parent: parent.id, revision: skill.revision, name });
        batch.push({
          key: key(id),
          event: {
            type: "skill_saved",
            data: { name, description: skill.description, code: skill.code },
          },
        });
      }
      const lesson = store.db
        .prepare(
          `SELECT seq, json_extract(value,'$.data.lesson') AS lesson FROM events
        WHERE scope=? AND json_extract(value,'$.type')='lesson_saved' ORDER BY random() LIMIT 1`,
        )
        .get(
          JSON.stringify([
            parentKey.runId,
            parentKey.worldId,
            parentKey.agentId,
          ]),
        );
      if (lesson) {
        const text = String(lesson.lesson);
        child.lessons.push(text);
        inherited.push({
          parent: parent.id,
          revision: Number(lesson.seq),
          lesson: text,
        });
        batch.push({
          key: key(id),
          event: { type: "lesson_saved", data: { lesson: text } },
        });
      }
    }
    batch.push({
      key: key(id),
      event: {
        type: "birth",
        data: {
          ...child,
          replaced: life.id,
          tick: snapshot.tick,
          parents,
          inherited,
          pool,
        },
      },
    });
    children.push(child);
  }
  // Commit the entire selection before changing any clients. Resume replays these exact draws.
  if (
    pool.length < 2 &&
    store.db
      .prepare(
        "SELECT 1 FROM events WHERE json_extract(value,'$.type')='extinction'",
      )
      .get()
  )
    throw new Error("Fewer than two living parents remain");
  if (pool.length < 2)
    batch.push({
      key: key(dead[0].id),
      event: {
        type: "extinction",
        data: { tick: snapshot.tick, survivors: pool },
      },
    });
  store.appendBatch(batch);
  if (pool.length < 2) throw new Error("Fewer than two living parents remain");
  return children;
}
