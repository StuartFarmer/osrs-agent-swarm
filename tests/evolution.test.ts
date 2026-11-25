import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { population, chooseParents, replaceDeaths } from "../src/evolution.ts";
import { scoreboard } from "../src/scoreboard.ts";
import { spectatorPath } from "../src/spectator.ts";
import { loadExperiment } from "../src/config.ts";
import { initializeBundledNames, allocateNames } from "../src/names.ts";

test("each draw uses remaining wealth and handles zero totals", () => {
  const pool = [0, 10, 30].map((wealth, i) => ({
    id: String(i),
    wealth,
    generation: 0,
  }));
  const [a, b] = chooseParents(pool, () => 0.25);
  assert.deepEqual(
    [a.id, a.probability, b.id, b.probability],
    ["2", 0.75, "1", 1],
  );
  assert.deepEqual(
    chooseParents(
      pool.map((p) => ({ ...p, wealth: 0 })),
      () => 0,
    ).map((p) => p.probability),
    [1 / 3, 1 / 2],
  );
  assert.throws(() => chooseParents(pool.slice(0, 1)));
});

test("simultaneous deaths draw only living parents, journal inheritance, and survive restart and a second generation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-birth-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const exp = await loadExperiment("experiments/concepcion-evolution.json");
  const founders = exp.agents.slice(0, 4),
    config = founders.map((a) => a.id);
  const key = (id: string) => ({ runId: "r", worldId: "w", agentId: id });
  const accounts = (ids: string[]) =>
    ids.map((agentId) => ({ agentId, username: agentId, password: "private" }));
  const snapshot = (ids: string[], dead: string[]) => ({
    tick: 101,
    deaths: Object.fromEntries(
      dead.map((id) => [id, { tick: 100, cause: "player_death", time: 10 }]),
    ),
    players: Object.fromEntries(
      ids.map((id) => [
        id,
        { wealth: 13, cash: 13, saleProceeds: 0, assets: {}, unsold: {} },
      ]),
    ),
  });
  const path = join(dir, "life.sqlite");
  let db = new Store(path);
  for (const id of config) {
    db.append(key(id), {
      type: "skill_saved",
      data: { name: id, description: "a routine", code: "return 1" },
    });
    db.append(key(id), {
      type: "lesson_saved",
      data: { lesson: "lesson from " + id },
    });
    db.updateMemory(
      key(id),
      0,
      {
        plan: ["private"],
        beliefs: [],
        relationships: { bob: "enemy" },
        nextAction: "private",
      },
      "test",
    );
  }
  const children = replaceDeaths(
    db,
    key,
    population(founders),
    accounts(config),
    snapshot(config, config.slice(0, 2)),
    0,
  );
  assert.equal(children.length, 2);
  for (const child of children) {
    assert.equal(child.generation, 1);
    assert.equal(db.readMemory(key(child.id)).revision, 0);
    assert.deepEqual(
      db.savedSkills(key(child.id)).map((s) => s.name),
      config.slice(2),
    );
    const birth = db.events(key(child.id)).find((e) => e.type === "birth")!
      .data as any;
    assert.deepEqual(
      birth.parents.map((p: any) => p.id).sort(),
      config.slice(2),
    );
    assert.deepEqual(
      birth.parents.map((p: any) => p.probability),
      [0.5, 1],
    );
    assert.equal(birth.inherited.length, 4);
  }
  db.close();
  db = new Store(path);
  t.after(() => db.close());
  const lives = population(founders, db),
    ids = lives.map((l) => l.id);
  assert.deepEqual(
    replaceDeaths(
      db,
      key,
      lives,
      accounts(ids),
      snapshot(ids, config.slice(0, 2)),
      0,
    ),
    [],
  );
  const next = replaceDeaths(
    db,
    key,
    lives,
    accounts(ids),
    snapshot(ids, config.slice(2)),
    0,
  );
  assert.ok(next.every((c) => c.generation === 2));
});

test("the tunneled scoreboard pages only public valuations, including zero and unknown values", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "swarm-score-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const world = join(root, ".local/worlds/w"),
    run = join(root, "runs/r");
  await mkdir(world, { recursive: true });
  await mkdir(run, { recursive: true });
  assert.equal((await scoreboard(world, 0)).runId, null);
  await writeFile(
    join(world, "scoreboard-run.json"),
    JSON.stringify({ runId: "r" }),
  );
  const db = new Store(join(run, "state.sqlite"));
  const key = { runId: "r", worldId: "w", agentId: "alice" };
  db.append(key, { type: "lesson_saved", data: { lesson: "PRIVATE" } });
  for (const position of [{ wealth: 0, cash: 0 }, null])
    db.append(key, {
      type: "local_ge_wealth",
      data: { username: "public", tick: 10, position, private: "PRIVATE" },
    });
  db.close();
  const page = await scoreboard(world, 0);
  assert.deepEqual(
    page.rows.map((r) => r.wealth),
    [0, null],
  );
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE/);
  assert.equal(
    (await scoreboard(world, Number(page.rows[0].seq))).rows.length,
    1,
  );
  assert.equal(spectatorPath("GET", "/wealth/"), "/wealth/");
  assert.equal(
    spectatorPath("GET", "/spectator/wealth/0"),
    "/spectator/wealth/0",
  );
  assert.equal(spectatorPath("POST", "/spectator/wealth/0"), null);
});

test("the checked-in scrape seeds the default roster without shipping prior allocations", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-scrape-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "names.sqlite");
  initializeBundledNames(file);
  const exported = await readFile(
    new URL("../src/hiscore-names.tsv", import.meta.url),
    "utf8",
  );
  const ids = Array.from({ length: 25 }, (_, i) => "agent" + i);
  const allocated = allocateNames(file, "world", ids);
  assert.equal(exported.trimEnd().split("\n").length, 3998);
  assert.equal(new Set(allocated.map((a) => a.username)).size, 25);
  for (const a of allocated)
    assert.ok(exported.split("\n").includes(a.username + "\t" + a.displayName));
});
