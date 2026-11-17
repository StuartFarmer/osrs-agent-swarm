import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadExperiment } from "../src/config.ts";
import { accountsFor, startBrowser, stopBrowser } from "../src/browser.ts";
import { startRun, readManifest } from "../src/run.ts";
import { startWorld, stopWorld, readWorld, writeJson } from "../src/world.ts";
import { verifyRecorder } from "../src/recording.ts";
import type { Server } from "node:http";
import { startLite, stopLite } from "../src/lite.ts";
import { startSpectator } from "../src/spectator.ts";
import { seedContainerWorld, containerRunId } from "./state.ts";

const exec = promisify(execFile);
const { values } = parseArgs({
  options: { "view-only": { type: "boolean" }, experiment: { type: "string" } },
});
const controller = new AbortController(),
  signal = controller.signal;
const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const children: ChildProcess[] = [];
let stopping = false,
  worldStarted = false,
  browserStarted = false,
  failure: unknown;
const experiment = await loadExperiment(
  values.experiment ??
    process.env.SWARM_EXPERIMENT ??
    "experiments/headless-m1.json",
);
const headless = experiment.clientMode === "headless";
let spectator: Server | undefined;

function launch(command: string, args: string[]) {
  const child = spawn(command, args, {
    stdio: ["ignore", "inherit", "inherit"],
  });
  children.push(child);
  child.once("error", (error) => {
    failure = error;
    controller.abort(error);
  });
  child.once("exit", (code) => {
    if (!stopping) {
      failure = new Error(`${command} exited unexpectedly (${code})`);
      controller.abort(failure);
    }
  });
  return child;
}
async function waitForDisplay() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      await exec("xdpyinfo", [], { timeout: 2000 });
      return;
    } catch {}
    await delay(200, undefined, { signal });
  }
  throw new Error("Virtual desktop did not become ready");
}
async function waitForStop() {
  if (signal.aborted) return;
  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

try {
  if (experiment.world.id !== "m1")
    throw new Error(
      "This image contains the m1 world; keep the experiment world ID as m1",
    );
  if (
    !values["view-only"] &&
    (!experiment.model || !process.env[experiment.model.apiKeyEnv])
  )
    throw new Error(
      "Export OPENROUTER_API_KEY before docker compose up, or launch with --view-only",
    );
  if (!headless) await verifyRecorder();
  const pointer = join(process.cwd(), ".local/container-run.json");
  const resumeRunId = await containerRunId(pointer);
  let finished = false;
  if (resumeRunId) {
    const previous = await readManifest(resumeRunId);
    if (JSON.stringify(previous.experiment) !== JSON.stringify(experiment))
      throw new Error(
        "Saved experiment differs; preserve its state and use a fresh experiment volume for changed configuration",
      );
    if (previous.worldId !== experiment.world.id)
      throw new Error("Saved container run belongs to another world");
    finished = previous.deadline !== null && Date.now() >= previous.deadline;
  }
  console.error("[container] Preparing persistent world state...");
  await seedContainerWorld("/opt/swarm-world", experiment.world.id);
  signal.throwIfAborted();
  if (!headless) {
    launch("Xvfb", [
      ":99",
      "-screen",
      "0",
      "1280x900x24",
      "-nolisten",
      "tcp",
      "-ac",
    ]);
    await waitForDisplay();
    launch("openbox", []);
    launch("x11vnc", [
      "-display",
      ":99",
      "-localhost",
      "-rfbport",
      "5900",
      "-forever",
      "-shared",
      "-nopw",
      "-quiet",
    ]);
    launch("websockify", [
      "--web",
      "/usr/share/novnc",
      "0.0.0.0:6080",
      "127.0.0.1:5900",
    ]);
    console.error(
      "[container] View agents at http://localhost:6080/vnc.html?autoconnect=true&resize=scale",
    );
  }
  console.error("[container] Starting the game server and gateway...");
  const world = await startWorld(
    experiment.world.id,
    process.cwd(),
    signal,
    experiment.world.tickMs,
  );
  worldStarted = true;
  if (headless) {
    spectator = await startSpectator(world, 6080, "0.0.0.0");
    console.error(
      "[container] Read-only map: http://localhost:6080/mapview/; 3D feed: ws://localhost:6080/worldfeed",
    );
  }
  console.error(
    `[container] World ready; opening ${experiment.agents.length} ${headless ? "headless" : "rendered"} clients...`,
  );
  const accounts = await accountsFor(world, experiment.agents);
  const browser = headless
    ? await startLite(world, accounts, signal)
    : await startBrowser(world, accounts);
  browserStarted = true;
  await browser.close();
  signal.throwIfAborted();
  if (values["view-only"] || finished) {
    console.error(
      finished
        ? `[container] ${resumeRunId} has reached its original deadline; no new inference started.`
        : "[container] View-only: world and clients are running; no inference started.",
    );
  } else {
    console.error(
      resumeRunId
        ? `[container] Resuming ${resumeRunId} with its original deadline and budget.`
        : `[container] Starting ${headless ? "headless" : "recorded"} experiment (${experiment.durationSeconds}s wall time, ${experiment.world.tickMs}ms ticks).`,
    );
    const report = await startRun(experiment, {
      signal,
      record: !headless,
      resumeRunId,
      onRunCreated: (runId) => writeJson(pointer, { runId }),
    });
    console.log(JSON.stringify(report, null, 2));
    console.error(
      "[container] Harness finished. Viewer remains available; docker compose stop swarm shuts down the world.",
    );
  }
  await waitForStop();
} catch (error) {
  if (!signal.aborted) failure = error;
} finally {
  stopping = true;
  controller.abort();
  const cleanupErrors: unknown[] = [];
  if (spectator)
    await new Promise<void>((resolve) => spectator!.close(() => resolve()));
  if (browserStarted) {
    try {
      const world = await readWorld(experiment.world.id);
      if (headless) await stopLite(world);
      else await stopBrowser(world);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (worldStarted) {
    try {
      await stopWorld(experiment.world.id);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  for (const child of children.reverse()) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
  }
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  if (failure || cleanupErrors.length) {
    console.error(
      "[container]",
      failure ?? "Shutdown failed",
      ...cleanupErrors,
    );
    process.exitCode = 1;
  }
}
