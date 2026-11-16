import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  symlink,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadExperiment } from "../src/config.ts";

test("demo has ten independently configured agents and no implicit paid model", async () => {
  const e = await loadExperiment("experiments/m1.json");
  assert.equal(e.agents.length, 10);
  assert.equal(e.model, null);
  assert.equal(e.concurrency, 4);
  assert.equal(e.durationSeconds, 1800);
});

test("rejects malformed experiments before opening clients or calling models", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "agents"));
  await writeFile(join(dir, "agents/profile.json"), "{}");
  await writeFile(join(dir, "agents/instructions.md"), "Earn coins.");
  const base = JSON.parse(await readFile("experiments/m1.json", "utf8"));
  base.agents = [
    {
      id: "alice",
      definition: "merchant",
      profilePath: "agents/profile.json",
      instructionsPath: "agents/instructions.md",
    },
  ];
  const file = join(dir, "experiment.json");
  for (const patch of [
    { surprise: true },
    { concurrency: 0 },
    { durationSeconds: -1 },
    { agents: [base.agents[0], base.agents[0]] },
    { world: { ...base.world, gameUrl: "https://example.com" } },
    { world: { ...base.world, gatewayUrl: "ws://localhost.evil:7780" } },
    { agents: [{ ...base.agents[0], id: "../bob" }] },
    { agents: [{ ...base.agents[0], definition: "../../secret" }] },
    { agents: [{ ...base.agents[0], profilePath: "../secret" }] },
  ]) {
    await writeFile(file, JSON.stringify({ ...base, ...patch }));
    await assert.rejects(loadExperiment(file, dir));
  }
  await symlink(tmpdir(), join(dir, "outside"));
  await writeFile(
    file,
    JSON.stringify({
      ...base,
      agents: [{ ...base.agents[0], profilePath: "outside/secret" }],
    }),
  );
  await assert.rejects(loadExperiment(file, dir));
});
