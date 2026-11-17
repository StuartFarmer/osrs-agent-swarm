import { readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { writeJson, SDK_REVISION } from "./world.ts";
import { identifier } from "./config.ts";
type Evidence = {
  seq: number;
  runId: string;
  worldId: string;
  agentId: string;
  type: string;
  requestId?: string;
  actionId?: string;
  time: string;
  data: any;
};
async function readJson(path: string): Promise<any> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
async function contained(root: string, path: string): Promise<string> {
  const p = await realpath(resolve(root, path)),
    rel = relative(await realpath(root), p);
  if (rel.startsWith("../") || rel === ".." || isAbsolute(rel))
    throw new Error("evidence escapes run");
  return p;
}
export async function checkAcceptance(runDir: string): Promise<{
  passed: boolean;
  checks: Record<string, boolean>;
  missing: string[];
}> {
  const manifest = await readJson(join(runDir, "manifest.json")),
    report = await readJson(join(runDir, "report.json"));
  const headless = manifest?.experiment?.clientMode === "headless";
  const agents = manifest?.experiment?.agents ?? [],
    checks: Record<string, boolean> = {
      liveRun: manifest?.mode === "live" && manifest?.revision === SDK_REVISION,
      ...(headless
        ? {
            population: agents.length >= 1 && agents.length <= 1000,
            engineTiming:
              report?.worldTiming?.configuredTickMs ===
                manifest?.experiment?.world?.tickMs &&
              Number.isFinite(report?.worldTiming?.achievedSpeed) &&
              report.worldTiming.achievedSpeed > 0,
          }
        : {
            tenAgents: agents.length === 10,
            twoDefinitions:
              new Set(agents.map((a: any) => a.definition)).size >= 2,
          }),
      fullDuration:
        (headless
          ? manifest?.experiment?.durationSeconds > 0
          : manifest?.experiment?.durationSeconds === 1800) &&
        report?.status === "completed" &&
        report?.elapsedSeconds >= manifest?.experiment?.durationSeconds,
      socialSmoke: false,
      policyIsolation: false,
      ...(!headless
        ? {
            screenshot: false,
            profileEdit: false,
            harnessResume: false,
            tabRestored: false,
          }
        : {}),
    };
  const smoke = await readJson(join(runDir, "social-smoke.json"));
  checks.socialSmoke =
    smoke?.mode === "live" &&
    smoke?.revision === SDK_REVISION &&
    (!headless ||
      (smoke?.clientMode === "headless" &&
        smoke?.tickMs === manifest?.experiment?.world?.tickMs)) &&
    [
      "publicChat",
      "dmIsolation",
      "followStop",
      "tradeDeltas",
      "dropPickup",
    ].every((k) => smoke?.checks?.[k] === true);
  const policy = await readJson(join(runDir, "policy-check.json"));
  checks.policyIsolation =
    policy?.exitCode === 0 &&
    policy?.command ===
      "node --import tsx --test tests/agent-definition.test.ts" &&
    policy?.node?.startsWith("24.");
  for (const a of agents) {
    const id = identifier(a.id),
      prefix = "agent:" + id + ":",
      events: Evidence[] = [];
    try {
      const file = join(
        runDir,
        "agents",
        identifier(manifest.worldId),
        id,
        "events.jsonl",
      );
      const text = await readFile(file, "utf8");
      if (!text.endsWith("\n")) throw new Error("partial export");
      let previous = 0;
      for (const line of text.trimEnd().split("\n")) {
        const e = JSON.parse(line);
        if (
          e.runId !== manifest.runId ||
          e.worldId !== manifest.worldId ||
          e.agentId !== id ||
          !Number.isInteger(e.seq) ||
          e.seq <= previous
        )
          throw new Error("event identity");
        events.push(e);
        previous = e.seq;
      }
      checks[prefix + "validEvents"] = true;
    } catch {
      checks[prefix + "validEvents"] = false;
    }
    checks[prefix + "request"] = events.some(
      (e) =>
        e.type === "response" &&
        ["stop", "toolUse", "length"].includes(e.data?.stopReason),
    );
    checks[prefix + "memory"] = events.some(
      (e) =>
        e.type === "memory_updated" &&
        e.data?.actor === "agent" &&
        e.data?.revision > 0,
    );
    if (headless && a.definition === "runebench") {
      checks[prefix + "scriptExecution"] = events.some(
        (e) =>
          e.type === "script_result" &&
          e.data?.ok === true &&
          !!e.actionId &&
          events.some(
            (start) =>
              start.type === "script_started" &&
              start.actionId === e.actionId &&
              start.seq < e.seq,
          ),
      );
    } else
      checks[prefix + "gameAction"] = events.some(
        (e) =>
          e.type === "action_outcome" &&
          ["completed", "dispatched"].includes(e.data?.status) &&
          events.some(
            (i) => i.type === "action_intent" && i.actionId === e.actionId,
          ),
      );
    if (headless)
      checks[prefix + "initialState"] = events.some(
        (e) => e.type === "initial_state",
      );
    checks[prefix + "context"] = false;
    for (const e of events.filter(
      (e) => e.type === "request_prepared" && e.requestId,
    )) {
      try {
        const data = await readJson(
          await contained(
            runDir,
            join(
              "agents",
              manifest.worldId,
              id,
              identifier(e.requestId) + ".json",
            ),
          ),
        );
        if (
          data?.requestId === e.requestId &&
          data?.context?.messages?.length &&
          data?.context?.tools?.length
        )
          checks[prefix + "context"] = true;
      } catch {}
    }
    if (!headless) {
      checks.profileEdit ||= events.some((e) => e.type === "profile_changed");
      checks.harnessResume ||= events.some(
        (e) => e.type === "harness_attached" && e.data?.resume === true,
      );
      checks.tabRestored ||= events.some(
        (e) =>
          e.type === "agent_unavailable" &&
          events.some(
            (later) => later.seq > e.seq && later.type === "task_started",
          ),
      );
      for (const e of events.filter((e) => e.type === "screenshot")) {
        try {
          const b = await readFile(await contained(runDir, e.data.path));
          if (
            b
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          )
            checks.screenshot = true;
        } catch {}
      }
    }
  }
  const missing = Object.entries(checks)
    .filter(([, pass]) => !pass)
    .map(([name]) => name);
  const result = {
    profile: headless ? "headless" : "milestone-1",
    passed: missing.length === 0,
    checks,
    missing,
  };
  await writeJson(join(runDir, "acceptance.json"), result);
  return result;
}
