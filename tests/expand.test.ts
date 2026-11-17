import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentsFromGroups, expandExperiment } from "../src/expand.ts";
import { general } from "../agents/general.ts";
import { loadExperiment } from "../src/config.ts";

test("groups expand into uniquely numbered general agents", () => {
  const agents = agentsFromGroups(
    [
      { archetype: "merchant", count: 3 },
      { archetype: "gatherer", count: 4 },
      { archetype: "scammer", count: 1 },
    ],
    10,
  );
  assert.equal(agents.length, 8);
  assert.equal(new Set(agents.map((a) => a.id)).size, 8);
  assert.equal(agents[0].id, "merchant-01");
  assert.equal(agents.at(-1)!.id, "scammer-01");
  assert.ok(agents.every((a) => a.definition === "general"));
  assert.equal(
    agents[0].instructionsPath,
    "agents/archetypes/merchant/instructions.md",
  );
});

test("repeated archetype groups share one numbering sequence", () => {
  const agents = agentsFromGroups(
    [
      { archetype: "merchant", count: 2 },
      { archetype: "merchant", count: 1 },
    ],
    10,
  );
  assert.deepEqual(
    agents.map((a) => a.id),
    ["merchant-01", "merchant-02", "merchant-03"],
  );
});

test("rejects totals above maxAgents, empty runs and bad archetype names", () => {
  assert.throws(
    () => agentsFromGroups([{ archetype: "merchant", count: 11 }], 10),
    /maxAgents/,
  );
  assert.throws(
    () =>
      agentsFromGroups(
        [
          { archetype: "merchant", count: 6 },
          { archetype: "gatherer", count: 6 },
        ],
        10,
      ),
    /between 1 and 10/,
  );
  assert.throws(
    () => agentsFromGroups([{ archetype: "merchant", count: 0 }], 10),
    /between 1 and 10/,
  );
  assert.throws(
    () => agentsFromGroups([{ archetype: "../x", count: 1 }], 10),
    /archetype/,
  );
});

test("expandExperiment writes a loadable experiment and removes invalid output", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-expand-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const template = JSON.parse(await readFile("experiments/m1.template.json", "utf8"));
  const templatePath = join(dir, "template.json");
  const groupsPath = join(dir, "groups.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(templatePath, JSON.stringify(template));
  await writeFile(
    groupsPath,
    JSON.stringify({ groups: [{ archetype: "merchant", count: 2 }] }),
  );
  const out = join("experiments", "tmp-test-expanded.json");
  t.after(() => rm(out, { force: true }));
  const result = await expandExperiment({
    template: templatePath,
    groups: groupsPath,
    out,
  });
  assert.equal(result.agents, 2);
  const e = await loadExperiment(out);
  assert.equal(e.agents.length, 2);

  const badGroups = join(dir, "bad.json");
  await writeFile(
    badGroups,
    JSON.stringify({ groups: [{ archetype: "missing-profile", count: 1 }] }),
  );
  const bad = join("experiments", "tmp-test-bad.json");
  await assert.rejects(expandExperiment({ template: templatePath, groups: badGroups, out: bad }));
  await assert.rejects(access(bad));
});

test("shared general definition exposes every domain to every profile", () => {
  const view = general.observe({
    stamp: { sessionEpoch: "s", observationSeq: 1, observedAt: 0 },
    ageMs: 0,
    clientTick: 1,
    knownBank: null,
    raw: {
      player: {},
      skills: [],
      inventory: [{ id: 995, count: 7 }],
      equipment: [],
      nearbyPlayers: [],
      nearbyNpcs: [],
      nearbyLocs: [],
      groundItems: [],
      gameMessages: [],
      dialog: {},
      interface: {},
      trade: {},
      bank: {},
      shop: {},
    },
  } as never);
  assert.deepEqual(Object.keys(view.domains).sort(), [
    "bank",
    "chat",
    "interfaces",
    "inventory",
    "nearby",
    "position",
    "shop",
  ]);
  assert.equal(view.derived.liquidCoins, 7);
});

test("archetypes share the same base instructions", async () => {
  const base = (await readFile("agents/archetypes/merchant/instructions.md", "utf8"))
    .split("\n")[0];
  for (const name of ["gatherer", "scammer"]) {
    const text = await readFile(`agents/archetypes/${name}/instructions.md`, "utf8");
    assert.equal(text.split("\n")[0], base, `${name} base differs`);
  }
});
