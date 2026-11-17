import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { identifier, localUrl } from "./config.ts";
import type { Account } from "./browser.ts";
import {
  acquireWorldLock,
  ownsProcess,
  spawnOwned,
  stopOwned,
  writeJson,
  type WorldHandle,
  type OwnedProcess,
} from "./world.ts";

type Sessions = {
  roster: string;
  processes: Record<string, OwnedProcess>;
};
const rosterHash = (accounts: Account[]) =>
  createHash("sha256").update(JSON.stringify(accounts)).digest("hex");
const exec = promisify(execFile);

export async function readSessions(
  world: WorldHandle,
): Promise<Sessions | undefined> {
  try {
    return JSON.parse(await readFile(join(world.dir, "lite.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function attachLite(world: WorldHandle, accounts: Account[]) {
  const sessions = await readSessions(world);
  if (!sessions || sessions.roster !== rosterHash(accounts))
    throw new Error(
      "Headless clients missing or roster changed; run clients start first",
    );
  // Keep the original process identities: a replacement session requires an explicit harness resume.
  return {
    connected: async (id: string) => {
      const p = sessions.processes[id];
      return !!p && (await ownsProcess(p));
    },
    lost: async () => {
      // One process-table read for the whole fleet, including sessions with long-running scripts.
      const { stdout } = await exec(
        "ps",
        ["-axww", "-o", "pid=", "-o", "command="],
        { maxBuffer: 16 * 1024 * 1024, timeout: 5000 },
      );
      const commands = new Map(
        stdout
          .trim()
          .split("\n")
          .map((line) => {
            const match = line.trim().match(/^(\d+)\s+(.*)$/);
            return [Number(match?.[1]), match?.[2] ?? ""];
          }),
      );
      return accounts.find((a) => {
        const p = sessions.processes[a.agentId],
          command = p && commands.get(p.pid);
        return (
          !command?.includes("--swarm-owner=" + p?.token) ||
          !command.includes(p.script)
        );
      })?.agentId;
    },
    close: async () => {},
  };
}

export async function startLite(
  world: WorldHandle,
  accounts: Account[],
  signal?: AbortSignal,
) {
  const release = await acquireWorldLock("clients:" + world.dir);
  const created: OwnedProcess[] = [];
  try {
    signal?.throwIfAborted();
    localUrl(world.gameUrl, ["http:"]);
    localUrl(world.gatewayUrl, ["ws:"]);
    const browserFile = join(world.dir, "browser.json");
    if (existsSync(browserFile)) {
      const browser = JSON.parse(await readFile(browserFile, "utf8"));
      if (await ownsProcess(browser.process))
        throw new Error(
          "Stop the rendered clients before starting headless clients",
        );
    }
    let sessions = await readSessions(world);
    if (sessions && sessions.roster !== rosterHash(accounts)) {
      if (
        (
          await Promise.all(Object.values(sessions.processes).map(ownsProcess))
        ).some(Boolean)
      )
        throw new Error("Headless roster changed while clients are running");
      sessions = undefined;
    }
    sessions ??= { roster: rosterHash(accounts), processes: {} };
    const cwd = join(world.gameDir, "server/webclient");
    const runner = join(cwd, ".swarm-lite.ts");
    // The upstream CLI drains on SIGINT; owned processes receive SIGTERM on shutdown.
    await writeFile(
      runner,
      'process.once("SIGTERM", () => process.kill(process.pid, "SIGINT"));\nawait import("./src/lite/runner.ts");\n',
      { mode: 0o600 },
    );
    const specialMode = join(world.gameDir, "bots/logs/fleet-runtime.mode");
    if (existsSync(specialMode) && (await readFile(specialMode, "utf8")).trim())
      throw new Error(
        "Remove the upstream fleet runtime override before running research agents",
      );
    for (const account of accounts) {
      signal?.throwIfAborted();
      identifier(account.agentId);
      if (
        sessions.processes[account.agentId] &&
        (await ownsProcess(sessions.processes[account.agentId]))
      )
        continue;
      if (
        !/^[a-z0-9][a-z0-9_]{0,11}$/.test(account.username) ||
        !account.password ||
        account.password.length > 20 ||
        account.password.trim() !== account.password ||
        /[\r\n]/.test(account.password)
      )
        throw new Error("Invalid headless account credentials");
      const dir = join(world.gameDir, "bots", account.username);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(
        join(dir, "bot.env"),
        [
          `BOT_USERNAME=${account.username}`,
          `PASSWORD=${account.password}`,
          `SERVER=${new URL(world.gameUrl).host}`,
          `GATEWAY_URL=${world.gatewayUrl}`,
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      const p = await spawnOwned(
        "bun",
        [runner, account.username],
        cwd,
        join(world.dir, `lite-${account.agentId}.log`),
        { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        false,
      );
      created.push(p);
      sessions.processes[account.agentId] = p;
      await writeJson(join(world.dir, "lite.json"), sessions);
      // Spread cache loading and authentication instead of spawning the entire fleet at once.
      await delay(200, undefined, { signal });
      if (!(await ownsProcess(p)))
        throw new Error(
          `Headless client exited: ${account.agentId}; inspect its log`,
        );
    }
    return await attachLite(world, accounts);
  } catch (error) {
    const cleanup = await Promise.allSettled(
      created.map(async (p) => {
        if (await ownsProcess(p)) await stopOwned(p);
      }),
    );
    const failed = cleanup.filter((r) => r.status === "rejected");
    if (failed.length)
      throw new AggregateError(
        [error, ...failed.map((r) => r.reason)],
        "Headless startup and cleanup failed",
      );
    throw error;
  } finally {
    await release();
  }
}

export async function stopLite(world: WorldHandle): Promise<void> {
  const release = await acquireWorldLock("clients:" + world.dir);
  try {
    const sessions = await readSessions(world);
    if (!sessions) return;
    const results = await Promise.allSettled(
      Object.values(sessions.processes).map(async (p) => {
        if (await ownsProcess(p)) await stopOwned(p);
      }),
    );
    const errors = results.filter((r) => r.status === "rejected");
    if (errors.length)
      throw new AggregateError(
        errors.map((r) => r.reason),
        "Headless clients still draining",
      );
  } finally {
    await release();
  }
}
