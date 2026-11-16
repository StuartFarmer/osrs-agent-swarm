import { parseArgs } from "node:util";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadExperiment, identifier } from "./config.ts";
import { prepareWorld, startWorld, stopWorld, readWorld } from "./world.ts";
import { startBrowser, attachBrowser, accountsFor } from "./browser.ts";
import { startRun, readManifest, runDirectory } from "./run.ts";
import { Store } from "./store.ts";
import { validateMemory } from "./store.ts";
import { Trace } from "./trace.ts";
import { checkAcceptance } from "./acceptance.ts";
const help = `RuneScape swarm POC (run from the repository root)
  world create|start|stop WORLD_ID
  clients start --experiment experiments/m1.json
  run --experiment experiments/m1.json [--resume RUN_ID]
  status --run RUN_ID
  memory get|set --run RUN_ID --agent AGENT_ID [--expected-revision N --file memory.json]
  focus --run RUN_ID --agent AGENT_ID
  capture --run RUN_ID --agent AGENT_ID
  report --run RUN_ID
  help
World and browser lifetimes are separate from the agent harness. Ctrl-C stops the harness.
`;
async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      experiment: { type: "string" },
      resume: { type: "string" },
      run: { type: "string" },
      agent: { type: "string" },
      "expected-revision": { type: "string" },
      file: { type: "string" },
    },
  });
  const [command, sub, id] = positionals;
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  if (!command || command === "help") {
    console.log(help);
    return 0;
  }
  if (command === "world") {
    if (!id || !["create", "start", "stop"].includes(sub))
      throw new Error("Use world create|start|stop WORLD_ID");
    print(
      await (sub === "create"
        ? prepareWorld(id)
        : sub === "start"
          ? startWorld(id)
          : stopWorld(id)),
    );
    return 0;
  }
  if (command === "clients") {
    if (sub !== "start" || !values.experiment)
      throw new Error("Use clients start --experiment PATH");
    const e = await loadExperiment(values.experiment),
      world = await readWorld(e.world.id);
    const browser = await startBrowser(
      world,
      await accountsFor(world, e.agents),
    );
    await browser.close();
    print({ worldId: world.id, clients: e.agents.length });
    return 0;
  }
  if (command === "run") {
    if (!values.experiment) throw new Error("--experiment is required");
    const e = await loadExperiment(values.experiment),
      controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const report = await startRun(e, {
        resumeRunId: values.resume,
        signal: controller.signal,
      });
      print(report);
      return report.status === "completed" ? 0 : 2;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  }
  if (!values.run) throw new Error("--run is required");
  const manifest = await readManifest(values.run),
    dir = runDirectory(values.run);
  if (command === "report") {
    const acceptance = await checkAcceptance(dir);
    print({
      report: JSON.parse(await readFile(join(dir, "report.json"), "utf8")),
      acceptance,
    });
    return acceptance.passed ? 0 : 2;
  }
  await access(join(dir, "state.sqlite"));
  const store = new Store(join(dir, "state.sqlite")),
    trace = new Trace(
      dir,
      store,
      manifest.experiment.limits.artifactBytes,
      manifest.experiment.model
        ? [process.env[manifest.experiment.model.apiKeyEnv] ?? ""]
        : [],
    );
  try {
    if (command === "status") {
      print({
        runId: manifest.runId,
        startedAt: manifest.startedAt,
        deadline: manifest.deadline,
        spendingUsd: store.spending(),
        agents: manifest.experiment.agents.map((a) => {
          const key = {
            runId: manifest.runId,
            worldId: manifest.worldId,
            agentId: a.id,
          };
          let events = store.events(key),
            last = events.at(-1);
          while (events.length) {
            events = store.events(key, last!.seq);
            if (events.length) last = events.at(-1);
          }
          return {
            id: a.id,
            memoryRevision: store.readMemory(key).revision,
            pendingActions: store.pendingActions(key).length,
            lastEvent: last ?? null,
          };
        }),
      });
      return 0;
    }
    const agentId = identifier(values.agent);
    if (!manifest.experiment.agents.some((a) => a.id === agentId))
      throw new Error("agent does not belong to this run");
    const key = { runId: manifest.runId, worldId: manifest.worldId, agentId };
    if (command === "memory") {
      if (sub === "get") {
        print(store.readMemory(key));
        return 0;
      }
      if (
        sub !== "set" ||
        !values.file ||
        values["expected-revision"] === undefined
      )
        throw new Error("memory set requires --file and --expected-revision");
      const value = JSON.parse(await readFile(values.file, "utf8"));
      validateMemory(value, manifest.experiment.limits.memoryBytes);
      const m = store.updateMemory(
        key,
        Number(values["expected-revision"]),
        value,
        "operator",
      );
      await trace.flush(key);
      print(m);
      return 0;
    }
    if (command === "focus" || command === "capture") {
      const world = await readWorld(manifest.worldId),
        browser = await attachBrowser(
          world,
          await accountsFor(world, manifest.experiment.agents),
        );
      try {
        if (command === "focus") {
          await browser.focus(agentId);
          print({ focused: agentId });
        } else {
          const png = await browser.capture(agentId),
            path = await trace.capture(key, randomUUID(), png);
          store.append(key, {
            type: "screenshot",
            data: { path, capturedAt: Date.now(), actor: "operator" },
          });
          await trace.flush(key);
          print({ path: join(dir, path) });
        }
      } finally {
        await browser.close();
      }
      return 0;
    }
    throw new Error("Unknown command; use help");
  } finally {
    store.close();
  }
}
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
