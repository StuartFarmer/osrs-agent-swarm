import { readFile, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import type { Experiment, Profile } from "./types.ts";

export function object(
  value: unknown,
  fields: string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(label + " must be an object");
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).some((k) => !fields.includes(k)) ||
    fields.some((k) => !(k in result))
  )
    throw new Error(label + ": missing or unknown fields");
  return result;
}
export function number(
  value: unknown,
  min: number,
  max: number,
  label: string,
  integer = true,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  )
    throw new Error(label + ": invalid number");
  return value;
}
export function string(value: unknown, label: string, max = 4096): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(label + ": invalid string");
  return value;
}
export function identifier(value: unknown): string {
  const s = string(value, "identifier", 64);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(s))
    throw new Error("invalid identifier");
  return s;
}
export function localUrl(value: unknown, protocols: string[]): string {
  const url = new URL(string(value, "url"));
  if (
    !protocols.includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("local endpoint required");
  return url.origin;
}
export async function containedFile(
  root: string,
  name: unknown,
): Promise<string> {
  const base = await realpath(root);
  const p = string(name, "path");
  if (isAbsolute(p)) throw new Error("relative path required");
  const full = await realpath(resolve(base, p));
  const rel = relative(base, full);
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel))
    throw new Error("path escapes project");
  return full;
}
export async function loadExperiment(
  path: string,
  root = process.cwd(),
): Promise<Experiment> {
  const e = object(
    JSON.parse(await readFile(path, "utf8")),
    [
      "world",
      "durationSeconds",
      "preparationSeconds",
      "concurrency",
      "healthyDelayMs",
      "failureDelayMs",
      "limits",
      "model",
      "agents",
    ],
    "experiment",
  );
  const w = object(
    e.world,
    ["id", "gameUrl", "gatewayUrl", "tickMs", "xpRate"],
    "world",
  );
  identifier(w.id);
  localUrl(w.gameUrl, ["http:"]);
  localUrl(w.gatewayUrl, ["ws:"]);
  number(w.tickMs, 400, 400, "tickMs");
  number(w.xpRate, 1, 1, "xpRate");
  number(e.durationSeconds, 1, 1800, "durationSeconds");
  number(e.preparationSeconds, 1, 300, "preparationSeconds");
  number(e.concurrency, 1, 4, "concurrency");
  number(e.healthyDelayMs, 1000, 60000, "healthyDelayMs");
  number(e.failureDelayMs, 5000, 60000, "failureDelayMs");
  const maxima = {
    requests: 8,
    tools: 16,
    taskSeconds: 120,
    outputTokens: 2048,
    freshnessMs: 3000,
    contextBytes: 65536,
    memoryBytes: 16384,
    artifactBytes: 1073741824,
  };
  const l = object(e.limits, Object.keys(maxima), "limits");
  for (const [k, max] of Object.entries(maxima)) number(l[k], 1, max, k);
  if (e.model !== null) {
    const m = object(
      e.model,
      [
        "provider",
        "modelId",
        "baseUrl",
        "apiKeyEnv",
        "contextWindow",
        "costLimitUsd",
        "zeroCost",
        "rates",
      ],
      "model",
    );
    string(m.provider, "provider");
    string(m.modelId, "modelId");
    const url = new URL(string(m.baseUrl, "baseUrl"));
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("invalid model endpoint");
    if (
      url.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      throw new Error("remote model requires HTTPS");
    if (!/^[A-Z][A-Z0-9_]*$/.test(string(m.apiKeyEnv, "apiKeyEnv")))
      throw new Error("invalid key environment name");
    number(m.contextWindow, 1, 10000000, "contextWindow");
    number(m.costLimitUsd, 0, 1000000, "costLimitUsd", false);
    if (typeof m.zeroCost !== "boolean")
      throw new Error("zeroCost must be boolean");
    const rates = object(
      m.rates,
      ["input", "output", "cacheRead", "cacheWrite"],
      "rates",
    );
    for (const v of Object.values(rates)) number(v, 0, 1000000, "rate", false);
    if (
      m.zeroCost
        ? Object.values(rates).some((v) => v !== 0)
        : m.costLimitUsd === 0 || Object.values(rates).every((v) => v === 0)
    )
      throw new Error("explicit paid tariffs and cap or zeroCost required");
  }
  if (!Array.isArray(e.agents) || e.agents.length < 1 || e.agents.length > 10)
    throw new Error("need 1–10 agents");
  const ids = new Set();
  for (const value of e.agents) {
    const a = object(
      value,
      ["id", "definition", "profilePath", "instructionsPath"],
      "agent",
    );
    identifier(a.id);
    if (ids.has(a.id)) throw new Error("duplicate agent id");
    ids.add(a.id);
    if (!["merchant", "gatherer", "runebench"].includes(a.definition as string))
      throw new Error("unknown agent definition");
    await containedFile(root, a.profilePath);
    await containedFile(root, a.instructionsPath);
  }
  return e as unknown as Experiment;
}
export async function loadProfile(
  root: string,
  profilePath: string,
  instructionsPath: string,
): Promise<Profile> {
  const text = await readFile(await containedFile(root, profilePath), "utf8");
  const p = object(JSON.parse(text), ["role", "objective"], "profile");
  const instructions = await readFile(
    await containedFile(root, instructionsPath),
    "utf8",
  );
  return {
    role: string(p.role, "role"),
    objective: string(p.objective, "objective"),
    instructions: string(instructions, "instructions", 16384),
    hash: createHash("sha256")
      .update(text)
      .update("\0")
      .update(instructions)
      .digest("hex"),
  };
}
