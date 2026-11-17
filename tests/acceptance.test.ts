import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkAcceptance } from "../src/acceptance.ts";
import { SDK_REVISION } from "../src/world.ts";
test("headless acceptance uses measured timing and paired script evidence without requiring a browser", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-headless-accept-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const experiment = {
    clientMode: "headless",
    world: { tickMs: 50 },
    durationSeconds: 60,
    agents: [{ id: "a", definition: "runebench" }],
  };
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({
      mode: "live",
      runId: "r",
      worldId: "w",
      revision: SDK_REVISION,
      experiment,
    }),
  );
  await writeFile(
    join(dir, "report.json"),
    JSON.stringify({
      status: "completed",
      elapsedSeconds: 60,
      worldTiming: { configuredTickMs: 50, achievedSpeed: 7.5 },
    }),
  );
  await mkdir(join(dir, "agents/w/a"), { recursive: true });
  const events = [
    { type: "initial_state" },
    { type: "script_started", actionId: "s" },
    { type: "script_result", actionId: "s", data: { ok: true } },
  ].map((e, i) => ({
    seq: i + 1,
    runId: "r",
    worldId: "w",
    agentId: "a",
    ...e,
  }));
  await writeFile(
    join(dir, "agents/w/a/events.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  const report = await checkAcceptance(dir);
  assert.equal(report.checks.engineTiming, true);
  assert.equal(report.checks["agent:a:scriptExecution"], true);
  assert.equal(report.checks["agent:a:initialState"], true);
  assert.equal("screenshot" in report.checks, false);
  assert.equal(
    report.passed,
    false,
    "missing model and social evidence must still fail",
  );
  events[2].actionId = "unpaired";
  await writeFile(
    join(dir, "agents/w/a/events.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  assert.equal(
    (await checkAcceptance(dir)).checks["agent:a:scriptExecution"],
    false,
  );
});
test("offline or incomplete evidence cannot pass live acceptance", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-accept-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({
      mode: "offline",
      experiment: {
        agents: [{ id: "a", definition: "merchant" }],
        durationSeconds: 1800,
      },
    }),
  );
  await writeFile(
    join(dir, "report.json"),
    JSON.stringify({ status: "completed", elapsedSeconds: 1800 }),
  );
  const report = await checkAcceptance(dir);
  assert.equal(report.passed, false);
  assert.ok(report.missing.includes("liveRun"));
  assert.ok(report.missing.includes("tenAgents"));
  assert.ok(report.missing.includes("socialSmoke"));
  assert.ok(report.missing.includes("agent:a:request"));
  assert.ok(report.missing.includes("agent:a:memory"));
  assert.ok(report.missing.includes("agent:a:gameAction"));
  assert.ok(report.missing.includes("policyIsolation"));
});
test("malformed event evidence is reported instead of treated as successful", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-accept-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({
      worldId: "w",
      experiment: { agents: [{ id: "a", definition: "merchant" }] },
    }),
  );
  await mkdir(join(dir, "agents/w/a"), { recursive: true });
  await writeFile(join(dir, "agents/w/a/events.jsonl"), "broken\n");
  const report = await checkAcceptance(dir);
  assert.equal(report.passed, false);
  assert.ok(report.missing.includes("agent:a:validEvents"));
});
