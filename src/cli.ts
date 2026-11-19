import { parseArgs } from "node:util";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadExperiment, identifier } from "./config.ts";
import {
  prepareWorld,
  startWorld,
  stopWorld,
  readWorld,
  worldStats,
} from "./world.ts";
import {
  startBrowser,
  attachBrowser,
  accountsFor,
  stopBrowser,
} from "./browser.ts";
import {
  startRun,
  readManifest,
  runDirectory,
  acquireWorldLock,
} from "./run.ts";
import { rosterForResume } from "./evolution.ts";
import { Store } from "./store.ts";
import { validateMemory } from "./store.ts";
import { Trace } from "./trace.ts";
import { recordSession, verifyRecorder } from "./recording.ts";
import { checkAcceptance } from "./acceptance.ts";
import { startLite, stopLite } from "./lite.ts";
import { startSpectator } from "./spectator.ts";
const help = `RuneScape swarm POC (run from the repository root)
  world create|start|stop WORLD_ID [--tick-ms 50..400] [--experiment PATH]
  world stats
  view --world WORLD_ID  (3D spectator, agent inspector and map on localhost:6080)
  clients start|stop --experiment experiments/m1.json [--resume RUN_ID]
  run --experiment experiments/m1.json [--resume RUN_ID] [--record]
  record --run RUN_ID
  status --run RUN_ID
  memory get|set --run RUN_ID --agent AGENT_ID [--expected-revision N --file memory.json]
  focus --run RUN_ID --agent AGENT_ID
  capture --run RUN_ID --agent AGENT_ID
  report --run RUN_ID
  help
World and client lifetimes are separate from the agent harness. Ctrl-C stops the harness.
`;
async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      experiment: { type: "string" },
      world: { type: "string" },
      "tick-ms": { type: "string" },
      record: { type: "boolean", default: false },
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
  if (command === "view") {
    const server = await startSpectator(
      await readWorld(identifier(values.world)),
    );
    console.error(
      "3D spectator and agent inspector: http://localhost:6080/watch/; 2D map: http://localhost:6080/mapview/",
    );
    await new Promise<void>((resolve) => {
      const stop = () => server.close(() => resolve());
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return 0;
  }
  if (command === "world") {
    if (sub === "stats") {
      print(await worldStats());
      return 0;
    }
    if (!id || !["create", "start", "stop"].includes(sub))
      throw new Error("Use world create|start|stop WORLD_ID");
    print(
      await (sub === "create"
        ? prepareWorld(id)
        : sub === "start"
          ? startWorld(
              id,
              process.cwd(),
              undefined,
              values["tick-ms"] === undefined
                ? undefined
                : Number(values["tick-ms"]),
              values.experiment ? (await loadExperiment(values.experiment)).permadeath : false,
            )
          : stopWorld(id)),
    );
    return 0;
  }
  if (command === "clients") {
    if (!["start", "stop"].includes(sub) || !values.experiment)
      throw new Error("Use clients start|stop --experiment PATH");
    const e = await loadExperiment(values.experiment),
      world = await readWorld(e.world.id);
    if (sub === "stop") {
      if (e.clientMode === "headless") await stopLite(world);
      else await stopBrowser(world);
    } else {
      const controller = new AbortController(),
        stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        const accounts = await accountsFor(world, rosterForResume(e, values.resume));
        const clients =
          e.clientMode === "headless"
            ? await startLite(world, accounts, controller.signal, e.permadeath)
            : await startBrowser(world, accounts);
        await clients.close();
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      }
    }
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
        record: values.record,
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
  if (
    ["record", "focus", "capture"].includes(command) &&
    manifest.experiment.clientMode === "headless"
  )
    throw new Error(
      "Headless runs have no game canvas; use view --world " + manifest.worldId,
    );
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
        openRouterBalance: store.keyBalance()?.value,
        agents: rosterForResume(manifest.experiment, manifest.runId).map((a) => {
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
    if (command === "record") {
      if (!manifest.deadline || Date.now() >= manifest.deadline)
        throw new Error(
          "Run must have finished preparation and still be active to record",
        );
      await verifyRecorder();
      const release = await acquireWorldLock("recording:" + dir);
      const controller = new AbortController(),
        stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      let browser;
      try {
        const world = await readWorld(manifest.worldId),
          accounts = await accountsFor(world, manifest.experiment.agents);
        browser = await attachBrowser(world, accounts);
        const result = await recordSession({
          dir,
          runId: manifest.runId,
          worldId: manifest.worldId,
          agents: accounts,
          browser,
          deadline: manifest.deadline,
          signal: controller.signal,
          checkQuota: () => trace.check(),
          display:
            process.env.SWARM_CONTAINER === "1"
              ? process.env.DISPLAY
              : undefined,
        });
        print(result);
        if (result.status === "failed") return 1;
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        try {
          await browser?.close();
        } finally {
          await release();
        }
      }
      return 0;
    }
    const agentId = identifier(values.agent);
    if (!rosterForResume(manifest.experiment, manifest.runId).some((a) => a.id === agentId) &&
        !(manifest.experiment.permadeath && store.events({ runId: manifest.runId, worldId: manifest.worldId, agentId }, 0, 1).length))
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
      validateMemory(value);
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
