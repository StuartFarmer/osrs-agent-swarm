import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { identifier, loadProfile } from "./config.ts";
import type { Experiment, Profile, AgentEntry, AgentKey } from "./types.ts";
import { Store } from "./store.ts";
import { Trace } from "./trace.ts";
import { Gate, createProvider } from "./inference.ts";
import { startBillionContext } from "./billion-context.ts";
import { connectGame } from "./game.ts";
import type { GameClient } from "./game.ts";
import { attachBrowser, accountsFor } from "./browser.ts";
import { population, entriesFor, replaceDeaths } from "./evolution.ts";
import { startLite, attachLite } from "./lite.ts";
import type { BrowserHandle } from "./browser.ts";
import {
  readWorld,
  writeJson,
  SDK_REVISION,
  acquireWorldLock,
  worldStats,
  worldWealth,
} from "./world.ts";
import { wealthGini, type WealthSnapshot } from "./liquidation.ts";
import { osrsValue, runPrices, type FrozenPrices } from "./osrs-prices.ts";
import { runTask } from "./runtime.ts";
import { json } from "./agent-definition.ts";
import { merchant } from "../agents/merchant.ts";
import { recordSession, verifyRecorder } from "./recording.ts";
import type { RecordingResult } from "./recording.ts";
import { gatherer } from "../agents/gatherer.ts";
import { runebench } from "../agents/runebench.ts";
import { connectCodeGame } from "./code-worker.ts";
import { refreshKeyBalance, type KeyBalance } from "./openrouter-budget.ts";
export const definitions = { merchant, gatherer, runebench };
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
  worldEpoch?: string;
  endowmentHash?: string;
  initialWealth?: Record<string, number>;
  initialOsrsValue?: Record<string, number>;
};
export type RunReport = {
  runId: string;
  status: "completed" | "incomplete";
  elapsedSeconds: number;
  spendingUsd: number;
  stopReason?: "budget_exhausted" | "key_limit";
  openRouterBalance?: KeyBalance;
  economy?: {
    venue: "local GE";
    tick: number | null;
    gini: number | null;
    agents: Record<string, { start: number | null; end: number | null; gain: number | null;
      osrs?: { valuation: ReturnType<typeof osrsValue>; gain: number | null } }>;
    osrsPriceError?: string;
    error?: string;
  };
  failureReason?: string;
  worldTiming?: {
    configuredTickMs: number;
    elapsedTicks: number;
    elapsedWallSeconds: number;
    achievedSpeed: number;
    last: Awaited<ReturnType<typeof worldStats>>;
  };
  recording?: RecordingResult | { status: "failed"; error: string };
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
export { acquireWorldLock } from "./world.ts";
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
  durationSeconds: number | null,
  now: number,
): number | null {
  if (durationSeconds === null) return null;
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
export async function completedBudgetReport(dir: string): Promise<RunReport | undefined> {
  try {
    const report: RunReport = JSON.parse(await readFile(join(dir, "report.json"), "utf8"));
    if (report.runId !== basename(dir)) throw new Error("Saved report belongs to another run");
    if (report.status === "completed" && (report.stopReason === "budget_exhausted" || report.stopReason === "key_limit")) return report;
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
}
export async function startRun(
  experiment: Experiment,
  options: {
    resumeRunId?: string;
    signal?: AbortSignal;
    root?: string;
    record?: boolean;
    onRunCreated?: (runId: string) => Promise<void>;
  } = {},
): Promise<RunReport> {
  if (!experiment.model)
    throw new Error(
      "Explicit model endpoint, credential, tariffs and budget are required; no model calls made",
    );
  verifyRuntime();
  const headless = experiment.clientMode === "headless";
  if (experiment.durationSeconds === null && (!headless || experiment.model.provider !== "openrouter" || experiment.model.zeroCost))
    throw new Error("A budget-only run requires a paid headless OpenRouter experiment");
  if (headless && options.record)
    throw new Error(
      "Headless clients cannot record game canvases; use the spectator feed",
    );
  if (options.record) await verifyRecorder();
  const root = resolve(options.root ?? process.cwd()),
    world = await readWorld(experiment.world.id, root);
  if (
    world.gameUrl !== experiment.world.gameUrl ||
    world.gatewayUrl !== experiment.world.gatewayUrl ||
    world.tickMs !== experiment.world.tickMs ||
    world.xpRate !== experiment.world.xpRate
  )
    throw new Error(
      "world endpoint or timing mismatch; start the world with the experiment tick rate",
    );
  const provider = createProvider(experiment.model);
  const release = await acquireWorldLock(world.dir),
    controller = new AbortController();
  const outer = options.signal ?? new AbortController().signal;
  const signal = AbortSignal.any([outer, controller.signal]);
  const runId = options.resumeRunId ?? "run-" + randomUUID(),
    dir = runDirectory(runId, root);
  let store: Store | undefined,
    browser: BrowserHandle | undefined,
    clients:
      | (Pick<BrowserHandle, "connected" | "close"> & {
          lost?: () => Promise<string | undefined>;
        })
      | undefined,
    deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const games = new Map<string, GameClient>();
  let recording: Promise<void> | undefined;
  let monitoring: Promise<void> | undefined;
  let billingMonitor: Promise<void> | undefined;
  let compression: Awaited<ReturnType<typeof startBillionContext>> | undefined;
  let timingStart: { tick: number; wall: number } | undefined;
  let releaseRecording: (() => Promise<void>) | undefined;
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
        worldEpoch: world.epoch,
      };
      await writeJson(join(dir, "manifest.json"), manifest);
      await options.onRunCreated?.(runId);
    }
    console.error(`[run] ${runId}`);
    if (options.record)
      releaseRecording = await acquireWorldLock("recording:" + dir);
    store = new Store(join(dir, "state.sqlite"));
    const trace = new Trace(dir, store, experiment.limits.artifactBytes, [
      process.env[experiment.model.apiKeyEnv] ?? "",
    ]);
    const providerBudget = experiment.durationSeconds === null;
    const gate = new Gate(experiment.concurrency, store, providerBudget);
    const limited = new Set<string>();
    let lives = population(experiment.agents, experiment.permadeath ? store : undefined);
    let entries = entriesFor(experiment, lives);
    let accounts = await accountsFor(world, entries);
    await writeJson(join(world.dir, "scoreboard-run.json"), { runId });
    const report: RunReport = {
      runId,
      status: "incomplete",
      elapsedSeconds: 0,
      spendingUsd: store.spending(),
      agents: {},
    };
    const prior = store.db.prepare("SELECT DISTINCT json_extract(scope,'$[2]') AS id FROM events").all();
    for (const id of new Set([...prior.map(row => String(row.id)), ...entries.map(a => a.id)]))
      report.agents[id] = summarizeAgent(store, {
        runId,
        worldId: world.id,
        agentId: id,
      });
    const key = (id: string): AgentKey => ({
      runId,
      worldId: world.id,
      agentId: id,
    });
    let prices: FrozenPrices | undefined;
    const sampleWealth = async (phase: "start" | "sample" | "end") => {
      let snapshot: WealthSnapshot | undefined, error: string | undefined;
      try {
        snapshot = await worldWealth(world.dir);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      if (phase === "start") manifest.initialWealth = {};
      const agents: NonNullable<RunReport["economy"]>["agents"] = {};
      const values: number[] = [];
      const frame = randomUUID();
      for (const { agentId, username, displayName } of accounts) {
        const position = snapshot?.players[username];
        const retired = Boolean(snapshot?.deaths?.[username]);
        if (position) {
          if (!retired) values.push(position.wealth);
          if (phase === "start") manifest.initialWealth![agentId] = position.wealth;
        }
        const start = manifest.initialWealth?.[agentId] ?? null;
        const end = position?.wealth ?? null;
        agents[agentId] = { start, end, gain: start !== null && end !== null ? end - start : null };
        if (prices) {
          const valuation = position ? osrsValue(position.cash, position.assets, prices) : null;
          if (phase === "start" && valuation?.total != null)
            (manifest.initialOsrsValue ??= {})[agentId] = valuation.total;
          const base = manifest.initialOsrsValue?.[agentId];
          agents[agentId].osrs = { valuation, gain: base != null && valuation?.total != null ? valuation.total - base : null };
        }
        store!.append(key(agentId), { type: "local_ge_wealth", data: json({
          phase, frame, username, displayName, retired, tick: snapshot?.tick ?? null, position: position ?? null,
          error: error ?? (position ? null : "Player unavailable"),
        }) });
      }
      report.economy = { venue: "local GE", tick: snapshot?.tick ?? null,
        gini: values.length === accounts.length ? wealthGini(values) : null, agents,
        ...(prices?.error ? { osrsPriceError: prices.error } : {}), ...(error ? { error } : {}) };
      return snapshot;
    };
    if (manifest.deadline !== null && Date.now() >= manifest.deadline) {
      if (headless) {
        try {
          const previous = JSON.parse(
            await readFile(join(dir, "report.json"), "utf8"),
          ) as RunReport;
          if (previous.runId !== runId)
            throw new Error("Saved report belongs to another run");
          return previous;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      report.elapsedSeconds = (Date.now() - manifest.startedAt!) / 1000;
      for (const a of Object.values(report.agents))
        a.reason =
          "Original deadline expired; resume did not restart the clock.";
      await writeJson(join(dir, "report.json"), report);
      return report;
    }
    const refresh = (s: AbortSignal) => refreshKeyBalance(store!, process.env[experiment.model!.apiKeyEnv]!,
      experiment.model!.costLimitUsd, s);
    if (providerBudget) {
      if (options.resumeRunId) {
        const previous = await completedBudgetReport(dir);
        if (previous) return previous;
      }
      report.openRouterBalance = await refresh(signal);
      report.spendingUsd = report.openRouterBalance.spentUsd;
      if (report.openRouterBalance.remainingUsd <= 0) {
        report.stopReason = "budget_exhausted";
        report.status = "completed";
        report.elapsedSeconds = manifest.startedAt ? (Date.now() - manifest.startedAt) / 1000 : 0;
        await writeJson(join(dir, "report.json"), report);
        return report;
      }
    }
    compression = await startBillionContext(dir, signal);
    const contextService = compression;
    clients = headless
      ? experiment.permadeath && options.resumeRunId
        ? await startLite(world, accounts, signal, true)
        : await attachLite(world, accounts)
      : (browser = await attachBrowser(world, accounts));
    const prep = AbortSignal.any([
      signal,
      AbortSignal.timeout(experiment.preparationSeconds * 1000),
    ]);
    const connectAccount = async (account: (typeof accounts)[number], prep: AbortSignal) => {
      const scripted =
        entries.find((a) => a.id === account.agentId)!
          .definition === "runebench";
      const game = scripted
        ? await connectCodeGame(
            key(account.agentId),
            account,
            world,
            experiment.limits.freshnessMs,
            prep,
            root,
          )
        : await connectGame(
            key(account.agentId),
            account,
            world,
            experiment.limits.freshnessMs,
          );
      games.set(account.agentId, game);
      await game.ready(prep);
      if (!manifest.startedAt || (experiment.permadeath && !(account.agentId in (manifest.initialWealth ?? {})))) await game.prepare?.(prep);
    };
    const connected = await Promise.allSettled(accounts.map(account => connectAccount(account, prep)));
    const failed = connected.find((r) => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    await waitForReady(
      [...games.values()],
      experiment.preparationSeconds * 1000,
      prep,
    );
    if (headless) {
      const stats = await worldStats();
      if (stats.tickRate !== world.tickMs)
        throw new Error("Effective world tick rate changed");
      timingStart = { tick: stats.tick, wall: Date.now() };
      store!.append(key(accounts[0].agentId), {
        type: "world_start",
        data: json({
          epoch: world.epoch,
          resume: !!options.resumeRunId,
          ...stats,
        }),
      });
    }
    if (headless && experiment.agents.some(a => a.definition === "runebench"))
      prices = await runPrices(dir, manifest.startedAt !== null);
    const initialState = (id: string, g: GameClient) => {
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
    };
    if (!manifest.startedAt) {
      const baselines = [...games].map(([id, game]) => initialState(id, game));
      if (new Set(baselines).size !== 1)
        throw new Error(
          "initial skills/equipment/inventory differ across agents",
        );
      manifest.endowmentHash = baselines[0];
      const start = await sampleWealth("start");
      if (experiment.permadeath && (!start?.deaths || Object.keys(manifest.initialWealth!).length !== accounts.length))
        throw new Error("Evolution requires engine death tracking and complete founder valuations");
      manifest.startedAt = Date.now();
      manifest.deadline = runDeadline(
        manifest,
        experiment.durationSeconds,
        manifest.startedAt,
      );
      trace.check(65536);
      await writeJson(join(dir, "manifest.json"), manifest);
    }
    if (manifest.deadline !== null) deadlineTimer = setTimeout(
      () => controller.abort(new Error("run deadline")),
      Math.max(0, manifest.deadline! - Date.now()),
    );
    if (options.record) {
      recording = recordSession({
        dir,
        runId,
        worldId: world.id,
        agents: accounts,
        browser: browser!,
        deadline: manifest.deadline!,
        signal,
        checkQuota: () => trace.check(),
        display:
          process.env.SWARM_CONTAINER === "1" ? process.env.DISPLAY : undefined,
      })
        .then((result) => {
          report.recording = result;
          if (result.status === "failed")
            console.error(
              `[record] Recording failed (${result.directory}): ${result.error}. Agents will continue.`,
            );
        })
        .catch((error) => {
          report.recording = {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          };
          console.error(
            "[record]",
            report.recording.error,
            "Agents will continue.",
          );
        });
    }
    if (providerBudget) billingMonitor = (async () => {
      try {
        while (!signal.aborted) {
          await delay(5000, undefined, { signal });
          const balance = await refresh(signal);
          if (balance.spentUsd !== report.openRouterBalance?.spentUsd)
            console.error(`[billing] OpenRouter charged $${balance.spentUsd} of $${balance.limitUsd}`);
          report.openRouterBalance = balance;
          if (balance.remainingUsd <= 0) {
            report.stopReason = "budget_exhausted";
            controller.abort();
          }
        }
      } catch (e) {
        if (!signal.aborted) {
          report.failureReason = String(e);
          controller.abort(e);
        }
      }
    })();
    if (!experiment.permadeath && headless && clients.lost)
      monitoring = (async () => {
        try {
          while (!signal.aborted) {
            await delay(5000, undefined, { signal });
            const lost = await clients!.lost!();
            if (lost) {
              store!.append(key(lost), {
                type: "agent_unavailable",
                data: { reason: "headless session exited" },
              });
              await trace.flush(key(lost));
              throw new Error(
                `Headless session lost: ${lost}; reconcile before resuming`,
              );
            }
            if (!signal.aborted) await sampleWealth("sample");
          }
        } catch (error) {
          if (!signal.aborted) {
            report.failureReason =
              error instanceof Error ? error.message : String(error);
            controller.abort(error);
          }
        }
      })();
    const runLife = async (a: AgentEntry, signal: AbortSignal) => {
      const life = lives.find(l => l.id === a.id)!;
      const agentContext = contextService.agent(key(a.id), provider.model);
      let profile = (await reloadProfile(root, a)).profile;
      const moduleHash = hash(
        await readFile(join(root, "agents", a.definition + ".ts"), "utf8"),
      );
      store!.append(key(a.id), {
        type: "harness_attached",
        data: {
          moduleHash,
          resume: !!options.resumeRunId,
          clientMode: experiment.clientMode ?? "browser",
          tickMs: world.tickMs,
        },
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
        if (!(await clients!.connected(a.id))) {
          store!.append(key(a.id), {
            type: "agent_unavailable",
            data: {
              reason: headless
                ? "headless session exited"
                : "rendered tab missing",
            },
          });
          await trace.flush(key(a.id));
          report.agents[a.id].reason = headless
            ? "headless session exited"
            : "rendered tab missing";
          if (headless) {
            report.failureReason = `Headless session lost: ${a.id}; reconcile before resuming`;
            controller.abort(new Error(report.failureReason));
            break;
          }
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
              compression: agentContext,
              permadeath: experiment.permadeath,
              providerBudget,
              definition: definitions[a.definition],
              profile: experiment.permadeath ? { ...profile, instructions: profile.instructions +
                "\nDeath permanently ends this life. Your current local liquidation wealth determines your chance of becoming a parent. Save reusable routines and use save_lesson for general knowledge you can pass to descendants." +
                (life.lessons.length ? "\nInherited lessons: " + JSON.stringify(life.lessons) : "") } : profile,
              limits: experiment.limits,
            },
            signal,
          );
        } catch (e) {
          if (signal.aborted) break;
          controller.abort(e);
          throw e;
        }
        const stats = report.agents[a.id];
        stats.tasks++;
        stats.requests += result.requests;
        stats.tools += result.tools;
        stats.reason = result.reason;
        if (result.status === "key_limit") {
          limited.add(a.id);
          break;
        }
        if (result.status === "funding_failed") {
          report.failureReason = result.reason;
          controller.abort(new Error(result.reason));
          break;
        }
        if (result.status !== "completed") {
          stats.failures++;
          if (result.status === "context_exhausted" || result.status === "compression_failed") {
            report.failureReason ??= `${a.id}: ${result.reason}`;
            break;
          }
          try {
            if (!browser) throw new Error("Headless mode has no game canvas");
            const png = await browser.capture(a.id);
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
    };
    const jobs = new Map<string, { stop: AbortController; done: Promise<void>; finished: boolean }>();
    const launch = (entry: AgentEntry) => {
      const stop = new AbortController();
      const job = { stop, done: Promise.resolve(), finished: false };
      jobs.set(entry.id, job);
      job.done = runLife(entry, AbortSignal.any([signal, stop.signal])).catch(error => {
        report.failureReason ??= String(error);
        controller.abort(error);
      }).finally(() => { job.finished = true; });
    };
    if (experiment.permadeath) {
      try {
        while (!signal.aborted) {
          const snapshot = await sampleWealth("sample");
          if (!snapshot) throw new Error("Unable to value the living population");
          const children = replaceDeaths(store, key, lives, accounts, snapshot, manifest.startedAt!);
          if (children.length) {
            const replacing = new Set(children.map(c => c.slot));
            const retired = lives.filter(l => replacing.has(l.slot));
            for (const old of retired) jobs.get(old.id)?.stop.abort(new Error("Character died"));
            for (const old of retired) {
              const job = jobs.get(old.id);
              await job?.done;
              jobs.delete(old.id);
              await games.get(old.id)?.close();
              games.delete(old.id);
              report.agents[old.id].reason = "Character died";
              await trace.flush(key(old.id));
            }
            lives = population(experiment.agents, store);
            entries = entriesFor(experiment, lives);
            accounts = await accountsFor(world, entries);
            clients = await startLite(world, accounts, signal, true);
            const prep = AbortSignal.any([signal, AbortSignal.timeout(experiment.preparationSeconds * 1000)]);
            const connected = await Promise.allSettled(children.map(async child => {
              report.agents[child.id] = summarizeAgent(store!, key(child.id));
              await connectAccount(accounts.find(a => a.agentId === child.id)!, prep);
            }));
            const failed = connected.find(r => r.status === "rejected");
            if (failed?.status === "rejected") throw failed.reason;
          }
          const newborns = accounts.filter(a => !(a.agentId in manifest.initialWealth!));
          if (newborns.length) {
            const initial = await worldWealth(world.dir);
            for (const a of newborns) {
              const position = initial.players[a.username];
              if (!position || initialState(a.agentId, games.get(a.agentId)!) !== manifest.endowmentHash)
                throw new Error("Newborn endowment differs from founders: " + a.agentId);
              manifest.initialWealth![a.agentId] = position.wealth;
              if (prices) {
                const value = osrsValue(position.cash, position.assets, prices)?.total;
                if (value != null) (manifest.initialOsrsValue ??= {})[a.agentId] = value;
              }
              store.append(key(a.agentId), { type: "endowment", data: json({
                phase: "birth", username: a.username, tick: initial.tick, position, retired: false
              }) });
            }
            await writeJson(join(dir, "manifest.json"), manifest);
            await sampleWealth("sample");
          }
          const lost = await clients.lost?.();
          if (lost) throw new Error("Headless session lost: " + lost);
          for (const entry of entries) if (!jobs.has(entry.id)) launch(entry);
          if ([...jobs.values()].every(j => j.finished)) break;
          await delay(5000, undefined, { signal });
        }
      } catch (error) {
        if (!signal.aborted) report.failureReason = error instanceof Error ? error.message : String(error);
      } finally { controller.abort(); }
    } else {
      entries.forEach(launch);
    }
    const settled = await Promise.allSettled([...jobs.values()].map(j => j.done));
    controller.abort();
    await monitoring;
    await sampleWealth("end");
    await recording;
    report.elapsedSeconds = (Date.now() - manifest.startedAt!) / 1000;
    if (headless) {
      try {
        const last = await worldStats();
        const elapsedTicks = last.tick - timingStart!.tick;
        const elapsedWallSeconds = (Date.now() - timingStart!.wall) / 1000;
        if (last.tickRate !== world.tickMs || elapsedTicks < 0)
          throw new Error("Engine clock changed during the run");
        report.worldTiming = {
          configuredTickMs: world.tickMs,
          elapsedTicks,
          elapsedWallSeconds,
          achievedSpeed:
            elapsedWallSeconds > 0
              ? (elapsedTicks * 0.4) / elapsedWallSeconds
              : 0,
          last,
        };
        store!.append(key(accounts[0].agentId), {
          type: "world_end",
          data: json(report.worldTiming),
        });
        await trace.flush(key(accounts[0].agentId));
      } catch (error) {
        report.failureReason =
          error instanceof Error ? error.message : String(error);
        store!.append(key(accounts[0].agentId), {
          type: "world_timing_failed",
          data: { message: report.failureReason },
        });
      }
    }

    if (providerBudget) {
      await billingMonitor;
      try {
        report.openRouterBalance = await refresh(AbortSignal.timeout(30000));
        if (report.openRouterBalance.remainingUsd <= 0) report.stopReason = "budget_exhausted";
        else if (entries.every(a => limited.has(a.id))) report.stopReason = "key_limit";
      } catch (e) { report.failureReason ??= "Final OpenRouter balance unavailable: " + String(e); }
    }
    report.spendingUsd = store.spending();
    report.status =
      !report.failureReason &&
      (providerBudget ? !!report.stopReason : Date.now() >= manifest.deadline!) &&
      settled.every((r) => r.status === "fulfilled") &&
      report.recording?.status !== "failed"
        ? "completed"
        : "incomplete";
    for (const id of Object.keys(report.agents)) {
      store.append(key(id), {
        type: "run_stopped",
        data: { status: report.status, elapsedSeconds: report.elapsedSeconds },
      });
      await trace.flush(key(id));
    }
    trace.check(65536);
    await writeJson(join(dir, "report.json"), report);
    return report;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    controller.abort();
    await monitoring;
    await billingMonitor;
    await recording;
    await compression?.close();
    await releaseRecording?.();
    await Promise.allSettled([...games.values()].map((g) => g.close()));
    await clients?.close();
    store?.close();
    await release();
  }
}
