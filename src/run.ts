import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { identifier, loadProfile } from "./config.ts";
import type { Experiment, Profile, AgentEntry, AgentKey } from "./types.ts";
import { Store } from "./store.ts";
import { Trace } from "./trace.ts";
import { Gate, createProvider } from "./inference.ts";
import { connectGame } from "./game.ts";
import type { GameClient } from "./game.ts";
import { attachBrowser, accountsFor } from "./browser.ts";
import type { BrowserHandle } from "./browser.ts";
import { readWorld, writeJson, SDK_REVISION } from "./world.ts";
import { runTask } from "./runtime.ts";
import { json } from "./agent-definition.ts";
import { merchant } from "../agents/merchant.ts";
import { gatherer } from "../agents/gatherer.ts";
export const definitions = { merchant, gatherer };
export type RunManifest = {
  runId: string;
  worldId: string;
  revision: string;
  createdAt: number;
  startedAt: number | null;
  deadline: number | null;
  experiment: Experiment;
  configHash: string;
  mode: "live";
};
export type RunReport = {
  runId: string;
  status: "completed" | "incomplete";
  elapsedSeconds: number;
  spendingUsd: number;
  agents: Record<
    string,
    {
      tasks: number;
      requests: number;
      tools: number;
      failures: number;
      reason: string;
    }
  >;
};
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
export async function acquireWorldLock(
  identity: string,
): Promise<() => Promise<void>> {
  const port = 30000 + (parseInt(hash(identity).slice(0, 8), 16) % 20000),
    server = createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) =>
      reject(
        e.code === "EADDRINUSE"
          ? new Error("world is already owned or its lock port is in use")
          : e,
      ),
    );
    server.listen(port, "127.0.0.1", resolve);
  });
  return () =>
    new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
}
export async function waitForReady(
  games: Pick<GameClient, "ready">[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const controller = new AbortController(),
    combined = AbortSignal.any([signal, controller.signal]);
  const timer = setTimeout(
    () => controller.abort(new Error("preparation timeout")),
    timeoutMs,
  );
  try {
    await Promise.all(games.map((g) => g.ready(combined)));
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
export function runDeadline(
  saved: { startedAt: number | null; deadline: number | null },
  durationSeconds: number,
  now: number,
): number {
  return saved.deadline ?? now + durationSeconds * 1000;
}
export async function reloadProfile(
  root: string,
  agent: AgentEntry,
  previous?: Profile,
): Promise<{ profile: Profile; error?: string }> {
  try {
    return {
      profile: await loadProfile(
        root,
        agent.profilePath,
        agent.instructionsPath,
      ),
    };
  } catch (e) {
    if (!previous) throw e;
    return {
      profile: previous,
      error: "Invalid edited profile; retaining last valid revision.",
    };
  }
}
export function verifyRuntime(): void {
  if (process.versions.node.split(".")[0] !== "24")
    throw new Error("Node 24 required for live runs");
  for (const name of [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
  ]) {
    // Both pinned packages export dist/index.js; pi-ai does not export its manifest.
    const manifest = JSON.parse(
      readFileSync(
        new URL("../package.json", import.meta.resolve(name)),
        "utf8",
      ),
    );
    if (manifest.name !== name || manifest.version !== "0.84.2")
      throw new Error("Install pinned Pi 0.84.2 before live runs");
  }
}
export function runDirectory(id: string, root = process.cwd()): string {
  return join(resolve(root), "runs", identifier(id));
}
export async function readManifest(
  id: string,
  root = process.cwd(),
): Promise<RunManifest> {
  const m = JSON.parse(
    await readFile(join(runDirectory(id, root), "manifest.json"), "utf8"),
  ) as RunManifest;
  if (m.runId !== id) throw new Error("run identity mismatch");
  return m;
}
export function summarizeAgent(
  store: Store,
  key: AgentKey,
): RunReport["agents"][string] {
  const summary = { tasks: 0, requests: 0, tools: 0, failures: 0, reason: "" };
  let after = 0;
  for (;;) {
    const events = store.events(key, after, 1000);
    if (!events.length) return summary;
    for (const e of events)
      if (e.type === "task_finished") {
        const d = e.data as {
          requests: number;
          tools: number;
          status: string;
          reason: string;
        };
        summary.tasks++;
        summary.requests += d.requests;
        summary.tools += d.tools;
        if (d.status !== "completed") summary.failures++;
        summary.reason = d.reason;
      }
    after = events.at(-1)!.seq;
  }
}
export async function startRun(
  experiment: Experiment,
  options: { resumeRunId?: string; signal?: AbortSignal; root?: string } = {},
): Promise<RunReport> {
  if (!experiment.model)
    throw new Error(
      "Explicit model endpoint, credential, tariffs and budget are required; no model calls made",
    );
  verifyRuntime();
  const root = resolve(options.root ?? process.cwd()),
    world = await readWorld(experiment.world.id, root);
  if (
    world.gameUrl !== experiment.world.gameUrl ||
    world.gatewayUrl !== experiment.world.gatewayUrl
  )
    throw new Error("world endpoint mismatch");
  const provider = createProvider(
    experiment.model,
    experiment.limits.outputTokens,
  );
  const release = await acquireWorldLock(world.dir),
    controller = new AbortController();
  const outer = options.signal ?? new AbortController().signal;
  const signal = AbortSignal.any([outer, controller.signal]);
  const runId = options.resumeRunId ?? "run-" + randomUUID(),
    dir = runDirectory(runId, root);
  let store: Store | undefined,
    browser: BrowserHandle | undefined,
    deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const games = new Map<string, GameClient>();
  try {
    const configHash = hash(JSON.stringify(experiment));
    let manifest: RunManifest;
    if (options.resumeRunId) {
      manifest = await readManifest(runId, root);
      if (
        manifest.configHash !== configHash ||
        manifest.revision !== SDK_REVISION
      )
        throw new Error("resume experiment mismatch");
    } else {
      await mkdir(join(root, "runs"), { recursive: true });
      await mkdir(dir, { mode: 0o700 });
      manifest = {
        runId,
        worldId: world.id,
        revision: SDK_REVISION,
        createdAt: Date.now(),
        startedAt: null,
        deadline: null,
        experiment,
        configHash,
        mode: "live",
      };
      await writeJson(join(dir, "manifest.json"), manifest);
    }
    store = new Store(join(dir, "state.sqlite"));
    const trace = new Trace(dir, store, experiment.limits.artifactBytes, [
      process.env[experiment.model.apiKeyEnv] ?? "",
    ]);
    const gate = new Gate(experiment.concurrency, store),
      accounts = await accountsFor(world, experiment.agents);
    const report: RunReport = {
      runId,
      status: "incomplete",
      elapsedSeconds: 0,
      spendingUsd: store.spending(),
      agents: {},
    };
    for (const a of experiment.agents)
      report.agents[a.id] = summarizeAgent(store, {
        runId,
        worldId: world.id,
        agentId: a.id,
      });
    const key = (id: string): AgentKey => ({
      runId,
      worldId: world.id,
      agentId: id,
    });
    if (manifest.deadline !== null && Date.now() >= manifest.deadline) {
      report.elapsedSeconds = (Date.now() - manifest.startedAt!) / 1000;
      for (const a of Object.values(report.agents))
        a.reason =
          "Original deadline expired; resume did not restart the clock.";
      await writeJson(join(dir, "report.json"), report);
      return report;
    }
    browser = await attachBrowser(world, accounts);
    const prep = AbortSignal.any([
      signal,
      AbortSignal.timeout(experiment.preparationSeconds * 1000),
    ]);
    const connected = await Promise.allSettled(
      accounts.map(async (account) => {
        const game = await connectGame(
          key(account.agentId),
          account,
          world,
          experiment.limits.freshnessMs,
        );
        games.set(account.agentId, game);
        await game.ready(prep);
        if (!manifest.startedAt) await game.prepare?.(prep);
      }),
    );
    const failed = connected.find((r) => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    await waitForReady(
      [...games.values()],
      experiment.preparationSeconds * 1000,
      prep,
    );
    if (!manifest.startedAt) {
      const baselines = [...games].map(([id, g]) => {
        const o = g.observe();
        const values = {
          inventory: o.raw.inventory
            .map((x) => ({ id: x.id, count: x.count }))
            .sort((a, b) => a.id - b.id),
          equipment: o.raw.equipment
            .map((x) => ({ id: x.id, count: x.count }))
            .sort((a, b) => a.id - b.id),
          skills: o.raw.skills,
        };
        store!.append(key(id), { type: "initial_state", data: json(o) });
        return hash(JSON.stringify(values));
      });
      if (new Set(baselines).size !== 1)
        throw new Error(
          "initial skills/equipment/inventory differ across agents",
        );
      manifest.startedAt = Date.now();
      manifest.deadline = runDeadline(
        manifest,
        experiment.durationSeconds,
        manifest.startedAt,
      );
      trace.check(65536);
      await writeJson(join(dir, "manifest.json"), manifest);
    }
    deadlineTimer = setTimeout(
      () => controller.abort(new Error("run deadline")),
      Math.max(0, manifest.deadline! - Date.now()),
    );
    const tasks = experiment.agents.map(async (a) => {
      let profile = (await reloadProfile(root, a)).profile;
      const moduleHash = hash(
        await readFile(join(root, "agents", a.definition + ".ts"), "utf8"),
      );
      store!.append(key(a.id), {
        type: "harness_attached",
        data: { moduleHash, resume: !!options.resumeRunId },
      });
      while (!signal.aborted) {
        const changed = await reloadProfile(root, a, profile);
        if (changed.error || changed.profile.hash !== profile.hash) {
          store!.append(key(a.id), {
            type: changed.error ? "profile_rejected" : "profile_changed",
            data: {
              hash: changed.profile.hash,
              message: changed.error ?? "Applied at task boundary",
            },
          });
          profile = changed.profile;
        }
        const game = games.get(a.id)!;
        if (!(await browser!.connected(a.id))) {
          store!.append(key(a.id), {
            type: "agent_unavailable",
            data: { reason: "rendered tab missing" },
          });
          await trace.flush(key(a.id));
          report.agents[a.id].reason = "rendered tab missing";
          await delay(experiment.failureDelayMs, undefined, { signal }).catch(
            () => {},
          );
          continue;
        }
        let result;
        try {
          result = await runTask(
            {
              key: key(a.id),
              game,
              store: store!,
              trace,
              gate,
              provider,
              definition: definitions[a.definition],
              profile,
              limits: experiment.limits,
            },
            signal,
          );
        } catch (e) {
          controller.abort(e);
          throw e;
        }
        const stats = report.agents[a.id];
        stats.tasks++;
        stats.requests += result.requests;
        stats.tools += result.tools;
        stats.reason = result.reason;
        if (result.status !== "completed") {
          stats.failures++;
          try {
            const png = await browser!.capture(a.id);
            const path = await trace.capture(key(a.id), randomUUID(), png);
            store!.append(key(a.id), {
              type: "screenshot",
              data: { path, capturedAt: Date.now() },
            });
          } catch {
            /* Best effort capture; the action/model journal remains authoritative. */
          }
        }
        if (!signal.aborted)
          await delay(
            result.status === "completed"
              ? experiment.healthyDelayMs
              : experiment.failureDelayMs,
            undefined,
            { signal },
          ).catch(() => {});
      }
    });
    const settled = await Promise.allSettled(tasks);
    report.elapsedSeconds = (Date.now() - manifest.startedAt!) / 1000;
    report.spendingUsd = store.spending();
    report.status =
      Date.now() >= manifest.deadline! &&
      settled.every((r) => r.status === "fulfilled")
        ? "completed"
        : "incomplete";
    for (const a of experiment.agents) {
      store.append(key(a.id), {
        type: "run_stopped",
        data: { status: report.status, elapsedSeconds: report.elapsedSeconds },
      });
      await trace.flush(key(a.id));
    }
    trace.check(65536);
    await writeJson(join(dir, "report.json"), report);
    return report;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    controller.abort();
    await Promise.allSettled([...games.values()].map((g) => g.close()));
    await browser?.close();
    store?.close();
    await release();
  }
}
