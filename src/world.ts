import { mkdir, readFile, writeFile, rename, access } from "node:fs/promises";
import { existsSync, openSync, closeSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { identifier, number, MAX_WORLD_PLAYERS } from "./config.ts";
const exec = promisify(execFile);
export const SDK_REVISION = "3aa493c3d26680df5bae2b475cc1805e3db05ae3";
export type WorldHandle = {
  id: string;
  dir: string;
  gameDir: string;
  gameUrl: string;
  gatewayUrl: string;
  revision: string;
  tickMs: number;
  xpRate: number;
  epoch?: string;
};
export type OwnedProcess = { pid: number; token: string; script: string };
export const worldEnv = {
  // Upstream's custom content changes the original cache checksums (server/Dockerfile).
  BUILD_VERIFY: "false",
  WEBSITE_REGISTRATION: "false",
  EASY_STARTUP: "true",
  NODE_TICKRATE: "400",
  NODE_XPRATE: "1",
  WORLD_FEED: "true",
  MAX_PLAYERS_PER_IP: String(MAX_WORLD_PLAYERS),
  NODE_MAX_CONNECTED: String(MAX_WORLD_PLAYERS),
  WEB_PORT: "8888",
  WEB_MANAGEMENT_PORT: "8898",
  WEB_TRANSPORT_WORKER: "false",
  NODE_PORT: "43594",
  LOGIN_SERVER: "true",
  LOGIN_HOST: "127.0.0.1",
  LOGIN_PORT: "43500",
  FRIEND_SERVER: "true",
  FRIEND_HOST: "127.0.0.1",
  FRIEND_PORT: "45099",
  LOGGER_SERVER: "true",
  LOGGER_HOST: "127.0.0.1",
  LOGGER_PORT: "43501",
  AGENT_PORT: "7780",
  GATEWAY_HOSTNAME: "127.0.0.1",
  GATEWAY_PUBLIC_PORT: "0",
  GATEWAY_URL: "http://127.0.0.1:7780",
};
export function worldPath(id: string, root = process.cwd()): string {
  return join(resolve(root), ".local", "worlds", identifier(id));
}
function incompleteWorld(dir: string): Error {
  return new Error(
    `World directory exists but preparation is incomplete (world.json missing). Check the original world create error; files are preserved at ${dir}.`,
  );
}
export async function readWorld(
  id: string,
  root = process.cwd(),
): Promise<WorldHandle> {
  const dir = worldPath(id, root);
  if (existsSync(dir) && !existsSync(join(dir, "world.json")))
    throw incompleteWorld(dir);
  const w = JSON.parse(
    await readFile(join(dir, "world.json"), "utf8"),
  ) as WorldHandle;
  if (
    w.id !== id ||
    w.revision !== SDK_REVISION ||
    w.gameDir !== join(dir, "game") ||
    w.dir !== dir ||
    !Number.isInteger(w.tickMs) ||
    w.tickMs < 50 ||
    w.tickMs > 400 ||
    w.xpRate !== 1 ||
    w.gameUrl !== "http://127.0.0.1:8888" ||
    w.gatewayUrl !== "ws://127.0.0.1:7780"
  )
    throw new Error("world metadata mismatch");
  return w;
}
export async function writeJson(path: string, value: unknown): Promise<void> {
  const temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temp, path);
}
export function patchLoopback(source: string, expected: number): string {
  if (source.split("'0.0.0.0'").length - 1 !== expected)
    throw new Error("upstream pin changed: loopback patch refused");
  return source.replaceAll("'0.0.0.0'", "'127.0.0.1'");
}
export function patchPackingContext(source: string): string {
  const cachedReturn = `    if (!needsAnyConfigPackWork && !rebuildCategory && cache.has(0, 2)) {
        return;
    }

`;
  const before = `    if (!needsAnyConfigPackWork) {
        cache.write(0, 2, fs.readFileSync('data/pack/client/config'));
        return;
    }

`;
  const after = `    if (!needsAnyConfigPackWork) {
        // Model flag rebuilding also needs constants and parameter definitions.
        const { default: ParamType } = await importCached('#/cache/config/ParamType.js');
        ParamType.load('data/pack');
        cache.write(0, 2, fs.readFileSync('data/pack/client/config'));
        return;
    }

`;
  const anchor =
    "    // var domains are global, so we need to check for conflicts";
  if (source.split(after).length === 2) return source.replace(cachedReturn, "");
  if (
    source.split(before).length !== 2 ||
    source.split(cachedReturn).length !== 2 ||
    source.split(anchor).length !== 2 ||
    source.indexOf("CONSTANTS.set(name, value)") > source.indexOf(anchor)
  )
    throw new Error("upstream pin changed: packing context patch refused");
  return source
    .replace(cachedReturn, "")
    .replace(before, "")
    .replace(anchor, after + anchor);
}
async function installPackingContext(gameDir: string): Promise<void> {
  const path = join(gameDir, "server/engine/tools/pack/config/PackShared.ts");
  const before = await readFile(path, "utf8"),
    after = patchPackingContext(before);
  if (before !== after) await writeFile(path, after);
}
export function patchGatewayReadiness(source: string): string {
  const before = "status: 'running',\n                bots,";
  const after =
    "status: 'running',\n                loginServerConnected,\n                bots,";
  if (source.split(after).length === 2) return source;
  if (source.split(before).length !== 2)
    throw new Error("upstream pin changed: gateway readiness patch refused");
  return source.replace(before, after);
}
async function installGatewayReadiness(gameDir: string): Promise<void> {
  const path = join(gameDir, "server/gateway/gateway.ts");
  const before = await readFile(path, "utf8"),
    after = patchGatewayReadiness(before);
  if (before !== after) await writeFile(path, after);
}
async function command(
  cmd: string,
  args: string[],
  cwd: string,
  env = worldEnv,
): Promise<string> {
  const r = await exec(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 900000,
  });
  return r.stdout;
}
export async function prepareWorld(
  id: string,
  root = process.cwd(),
): Promise<WorldHandle> {
  const dir = worldPath(id, root);
  if (existsSync(dir)) {
    if (!existsSync(join(dir, "world.json"))) throw incompleteWorld(dir);
    throw new Error(
      "world already exists; saved state will not be overwritten",
    );
  }
  const vendor = join(resolve(root), "vendor/rs-sdk");
  const pin = (await command("git", ["rev-parse", "HEAD"], vendor)).trim();
  if (pin !== SDK_REVISION)
    throw new Error("initialize the pinned vendor/rs-sdk submodule first");
  await mkdir(join(resolve(root), ".local/worlds"), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(dir, { mode: 0o700 });
  const gameDir = join(dir, "game");
  await command("git", ["clone", "--no-hardlinks", vendor, gameDir], root);
  await command("git", ["checkout", "--detach", SDK_REVISION], gameDir);
  // Upstream binds several listeners on all interfaces. Patch only this disposable checkout.
  const patches: Record<string, number> = {
    "src/web/index.ts": 1,
    "src/server/tcp/TcpServer.ts": 1,
    "src/server/login/LoginServer.ts": 1,
    "src/server/friend/FriendServer.ts": 1,
    "src/server/logger/LoggerServer.ts": 2,
  };
  for (const [file, count] of Object.entries(patches)) {
    const path = join(gameDir, "server/engine", file);
    let source = patchLoopback(await readFile(path, "utf8"), count);
    if (file === "src/web/index.ts") {
      const needle = "port: Environment.WEB_MANAGEMENT_PORT,";
      if (source.split(needle).length !== 2)
        throw new Error("management listener patch mismatch");
      source = source.replace(
        needle,
        needle + "\n        hostname: '127.0.0.1',",
      );
    }
    await writeFile(path, source);
  }
  await installGatewayReadiness(gameDir);
  await installPackingContext(gameDir);
  const configDir = join(gameDir, "server/engine/data/config");
  await mkdir(configDir, { recursive: true });
  await writeJson(join(configDir, "world.json"), {
    easyStartup: true,
    website: { registration: false },
    node: { xpRate: 1, rateLimitDeviceLogin: 50, rateLimitAddressLogin: 50 },
    login: { enabled: true, host: "127.0.0.1" },
    friend: { enabled: true, host: "127.0.0.1" },
    logger: { enabled: true, host: "127.0.0.1" },
  });
  for (const sub of ["", "server/engine", "server/webclient", "server/gateway"])
    await command("bun", ["install", "--frozen-lockfile"], join(gameDir, sub));
  const engine = join(gameDir, "server/engine");
  await command("bun", ["run", "sqlite:migrate"], engine);
  await command("bun", ["run", "build"], engine);
  await command("bun", ["run", "build"], join(gameDir, "server/webclient"));
  const effective = JSON.parse(
    (
      await command(
        "bun",
        [
          "-e",
          "import E from './src/util/Environment.ts'; console.log(JSON.stringify({tick:E.NODE_TICKRATE,xp:E.node.xpRate,easy:E.easyStartup}))",
        ],
        engine,
      )
    ).trim(),
  );
  if (effective.tick !== 400 || effective.xp !== 1 || !effective.easy)
    throw new Error("effective world settings mismatch");
  const world: WorldHandle = {
    id,
    dir,
    gameDir,
    revision: pin,
    gameUrl: "http://127.0.0.1:8888",
    gatewayUrl: "ws://127.0.0.1:7780",
    tickMs: 400,
    xpRate: 1,
  };
  await writeJson(join(dir, "world.json"), world);
  await writeJson(join(dir, "preparation.json"), {
    at: new Date().toISOString(),
    effective,
    loopbackPatches: patches,
  });
  return world;
}
async function portFree(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  });
}
export async function ownsProcess(p: OwnedProcess): Promise<boolean> {
  if (!Number.isSafeInteger(p.pid) || p.pid <= 1 || !p.token || !p.script)
    return false;
  try {
    const { stdout } = await exec("ps", [
      "-p",
      String(p.pid),
      "-o",
      "command=",
    ]);
    return (
      stdout.includes("--swarm-owner=" + p.token) && stdout.includes(p.script)
    );
  } catch {
    return false;
  }
}
export async function stopOwned(p: OwnedProcess): Promise<void> {
  if (!(await ownsProcess(p)))
    throw new Error("process ownership not verified; refusing signal");
  process.kill(p.pid, "SIGTERM");
  for (let i = 0; i < 60; i++) {
    if (!(await ownsProcess(p))) return;
    await delay(500);
  }
  throw new Error("process is still draining; saves preserved, no forced kill");
}
export async function spawnOwned(
  script: string,
  args: string[],
  cwd: string,
  log: string,
  env: Record<string, string> = {},
  inheritEnv = true,
): Promise<OwnedProcess> {
  const token = randomUUID(),
    fd = openSync(log, "a", 0o600);
  try {
    const child = spawn(script, [...args, "--swarm-owner=" + token], {
      cwd,
      env: { ...(inheritEnv ? process.env : {}), ...env },
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    return { pid: child.pid!, token, script: args[0] ?? script };
  } finally {
    closeSync(fd);
  }
}
export async function worldReady(
  w: Pick<WorldHandle, "gameUrl" | "gatewayUrl">,
): Promise<boolean> {
  const gateway = new URL(w.gatewayUrl);
  gateway.protocol = "http:";
  gateway.pathname = "/status";
  const responses = await Promise.all([
    fetch(w.gameUrl, { signal: AbortSignal.timeout(1000) }),
    fetch(gateway, { signal: AbortSignal.timeout(1000) }),
  ]);
  if (!responses.every((r) => r.ok)) return false;
  const status = (await responses[1].json()) as {
    status?: string;
    loginServerConnected?: boolean;
  };
  return status.status === "running" && status.loginServerConnected === true;
}
export async function startWorld(
  id: string,
  root = process.cwd(),
  signal?: AbortSignal,
  tickMs?: number,
): Promise<WorldHandle> {
  signal?.throwIfAborted();
  const w = await readWorld(id, root),
    file = join(w.dir, "processes.json");
  if (existsSync(file)) {
    const previous = JSON.parse(await readFile(file, "utf8")) as OwnedProcess[];
    if ((await Promise.all(previous.map(ownsProcess))).some(Boolean))
      throw new Error(
        "world has owned running processes; use status/stop before start",
      );
  }
  if (tickMs !== undefined) {
    number(tickMs, 50, 400, "tickMs");
    w.tickMs = tickMs;
  }
  await installGatewayReadiness(w.gameDir);
  await installPackingContext(w.gameDir);
  await Promise.all(
    [8888, 8898, 7780, 43594, 43500, 45099, 43501].map(portFree),
  );
  const processes: OwnedProcess[] = [];
  w.epoch = randomUUID();
  try {
    for (const [sub, script] of [
      ["engine", "src/app.ts"],
      ["gateway", "gateway.ts"],
    ]) {
      const cwd = join(w.gameDir, "server", sub);
      const p = await spawnOwned(
        "bun",
        [join(cwd, script)],
        cwd,
        join(w.dir, sub + ".log"),
        { ...worldEnv, NODE_TICKRATE: String(w.tickMs) },
      );
      processes.push(p);
      await writeJson(file, processes);
    }
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (!(await Promise.all(processes.map(ownsProcess))).every(Boolean))
        throw new Error("world process exited; inspect local logs");
      const ready = await worldReady(w).catch(() => false);
      const stats = ready
        ? await worldStats().catch(() => undefined)
        : undefined;
      if (stats) {
        if (stats.tickRate !== w.tickMs)
          throw new Error("effective world tick rate mismatch");
        await writeJson(join(w.dir, "world.json"), w);
        return w;
      }
      await delay(500, undefined, { signal });
    }
    throw new Error("world preparation timeout");
  } catch (e) {
    await Promise.allSettled(
      processes.map(async (p) => {
        if (await ownsProcess(p)) await stopOwned(p);
      }),
    );
    throw e;
  }
}
export async function stopWorld(
  id: string,
  root = process.cwd(),
): Promise<void> {
  const w = await readWorld(id, root);
  const processes = JSON.parse(
    await readFile(join(w.dir, "processes.json"), "utf8"),
  ) as OwnedProcess[];
  for (const p of [...processes].reverse())
    if (await ownsProcess(p)) await stopOwned(p);
}

export async function acquireWorldLock(
  identity: string,
): Promise<() => Promise<void>> {
  const port =
      30000 +
      (parseInt(
        createHash("sha256").update(identity).digest("hex").slice(0, 8),
        16,
      ) %
        20000),
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

export async function worldStats(): Promise<{
  tick: number;
  tickRate: number;
  players: number;
  avg: Record<string, number>;
  peak: Record<string, number>;
  overBudget: number;
  window: number;
}> {
  const response = await fetch("http://127.0.0.1:8898/tickstats", {
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error("World timing endpoint unavailable");
  const stats = (await response.json()) as any;
  number(stats.tick, 0, Number.MAX_SAFE_INTEGER, "engine tick");
  number(stats.tickRate, 50, 400, "effective tickMs");
  return {
    tick: stats.tick,
    tickRate: stats.tickRate,
    players: stats.players,
    avg: stats.avg,
    peak: stats.peak,
    overBudget: stats.overBudget,
    window: stats.window,
  };
}
