import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { identifier, localUrl } from "./config.ts";
import { redact } from "./trace.ts";
import type { Account } from "./browser.ts";

type StateWorld = { dir: string; gatewayUrl: string };

async function accounts(world: StateWorld): Promise<Account[]> {
  const value = JSON.parse(
    await readFile(join(world.dir, "accounts.json"), "utf8"),
  );
  if (!Array.isArray(value)) throw new Error("Invalid account roster");
  for (const a of value) {
    identifier(a.agentId);
    if (
      typeof a.username !== "string" ||
      !/^[a-z0-9][a-z0-9_]{0,11}$/.test(a.username) ||
      typeof a.password !== "string" ||
      a.password.length < 1 ||
      a.password.length > 20 ||
      /[\r\n]/.test(a.password)
    )
      throw new Error("Invalid account roster");
  }
  return value;
}

export async function spectatorAgents(world: StateWorld) {
  try {
    const roster = await accounts(world);
    let active: Set<string> | undefined;
    try {
      const sessions = JSON.parse(await readFile(join(world.dir, "lite.json"), "utf8"));
      active = new Set(Object.keys(sessions.processes));
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    return roster.filter(a => !active || active.has(a.agentId)).map((a) => ({
      id: a.agentId,
      name: a.username,
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function spectatorState(world: StateWorld, id: string) {
  identifier(id);
  const account = (await accounts(world)).find((a) => a.agentId === id);
  if (!account) return { status: 404, body: { error: "Unknown agent" } };
  const origin = new URL(localUrl(world.gatewayUrl, ["ws:"]));
  origin.protocol = "http:";
  origin.pathname = "/state/" + encodeURIComponent(account.username);
  // The gateway already caches this observation; GET opens no SDK/controller session.
  const response = await fetch(origin, {
    method: "GET",
    headers: { Authorization: "Bearer " + account.password },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok)
    return {
      status: response.status === 404 ? 404 : 502,
      body: {
        error: "Agent observation unavailable; check client login and gateway",
      },
    };
  const data = (await response.json()) as any;
  if (
    !data.state ||
    typeof data.state !== "object" ||
    Array.isArray(data.state) ||
    !Number.isFinite(data.stateAge) ||
    data.stateAge < 0
  )
    throw new Error("Invalid gateway observation");
  const fields = [
    "tick",
    "revision",
    "inGame",
    "player",
    "skills",
    "inventory",
    "equipment",
    "combatStyle",
    "nearbyNpcs",
    "nearbyPlayers",
    "nearbyLocs",
    "groundItems",
    "gameMessages",
    "recentDialogs",
    "menuActions",
    "shop",
    "bank",
    "trade",
    "ge",
    "combatEvents",
    "dialog",
    "interface",
    "modalOpen",
    "modalInterface",
    "prayers",
    "specialEnergy",
    "specialActive",
  ];
  const state = redact(
    Object.fromEntries(
      fields.filter((f) => f in data.state).map((f) => [f, data.state[f]]),
    ),
    [account.password],
  );
  return {
    status: 200,
    body: {
      agent: { id: account.agentId, name: account.username },
      stateAgeMs: data.stateAge,
      status: ["active", "stale", "dead"].includes(data.botStatus)
        ? data.botStatus
        : "unknown",
      state,
    },
  };
}
