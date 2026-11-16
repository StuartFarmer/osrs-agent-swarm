import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { localUrl } from "./config.ts";
import { ownsProcess, spawnOwned, stopOwned, writeJson } from "./world.ts";
import type { WorldHandle, OwnedProcess } from "./world.ts";
import type { AgentEntry } from "./types.ts";
import { allocateNames, hasCollectedNames } from "./names.ts";
export type Account = {
  agentId: string;
  username: string;
  password: string;
  displayName?: string;
};
type Page = {
  url(): string;
  goto(url: string, options?: unknown): Promise<unknown>;
  close(): Promise<void>;
  bringToFront(): Promise<void>;
  screenshot(options: unknown): Promise<Uint8Array>;
  evaluate<T, A>(work: (arg: A) => T, arg: A): Promise<T>;
  isClosed(): boolean;
};
type Browser = {
  pages(): Promise<Page[]>;
  newPage(): Promise<Page>;
  disconnect(): Promise<void>;
};
export type BrowserHandle = {
  focus(agentId: string): Promise<void>;
  capture(agentId: string): Promise<Buffer>;
  captureGame(agentId: string, label: string): Promise<Buffer>;
  connected(agentId: string): Promise<boolean>;
  close(): Promise<void>;
};
export async function accountsFor(
  world: WorldHandle,
  agents: AgentEntry[],
  namePool = process.env.SWARM_NAMES_DB ??
    resolve(".local/hiscores/names.sqlite"),
): Promise<Account[]> {
  const path = join(world.dir, "accounts.json");
  if (existsSync(path)) {
    const accounts = JSON.parse(await readFile(path, "utf8")) as Account[];
    if (
      accounts.length !== agents.length ||
      accounts.some(
        (a, i) =>
          a.agentId !== agents[i].id ||
          !/^[a-z0-9][a-z0-9_]{0,11}$/.test(a.username) ||
          a.username.endsWith("_"),
      )
    )
      throw new Error("account roster mismatch");
    if (
      accounts.some(
        (a) =>
          typeof a.password !== "string" ||
          a.password.length < 1 ||
          a.password.length > 20,
      )
    )
      throw new Error(
        "Stored account passwords must be 1–20 characters; repair incompatible credentials before starting clients.",
      );
    return accounts;
  }
  const prefix = randomBytes(3).toString("hex");
  if (process.env.SWARM_NAMES_DB && !existsSync(namePool))
    throw new Error("configured name pool does not exist");
  const usePool = existsSync(namePool) && hasCollectedNames(namePool);
  if (process.env.SWARM_NAMES_DB && !usePool)
    throw new Error("configured name pool contains no collected names");
  const identities = usePool
    ? allocateNames(
        namePool,
        resolve(world.dir),
        agents.map((a) => a.id),
      )
    : agents.map((a, i) => ({
        agentId: a.id,
        username: "s" + prefix + String(i + 1).padStart(2, "0"),
      }));
  if (!usePool)
    console.error(
      "[names] No collected name pool yet; using synthetic names for this new roster.",
    );
  const accounts = identities.map((identity) => ({
    ...identity,
    password: "admin",
  }));
  await writeFile(path, JSON.stringify(accounts, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  return accounts;
}
function botName(page: Page, origin: string): string | null {
  try {
    const u = new URL(page.url());
    return u.origin === origin && u.pathname === "/bot"
      ? u.searchParams.get("bot")
      : null;
  } catch {
    return null;
  }
}
export async function ensureTabs(
  browser: Browser,
  origin: string,
  accounts: Account[],
): Promise<Map<string, Page>> {
  localUrl(origin, ["http:"]);
  const pages = await browser.pages(),
    result = new Map<string, Page>(),
    created: Page[] = [];
  try {
    for (const a of accounts) {
      console.error(`[browser] Opening game tab for ${a.agentId}...`);
      const matches = pages.filter((p) => botName(p, origin) === a.username);
      if (matches.length > 1)
        throw new Error("duplicate character tabs: " + a.agentId);
      let page = matches[0];
      const navigate =
        !page ||
        new URL(page.url()).searchParams.get("password") !== a.password;
      if (!page) {
        page = await browser.newPage();
        created.push(page);
      }
      if (navigate) {
        const url = new URL("/bot", origin);
        url.searchParams.set("bot", a.username);
        url.searchParams.set("password", a.password);
        await page.goto(url.href, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
      }
      result.set(a.agentId, page);
    }
    return result;
  } catch (e) {
    await Promise.allSettled(created.map((p) => p.close()));
    throw e;
  }
}
async function connect(endpoint: string): Promise<Browser> {
  const packageName = "puppeteer";
  const { default: puppeteer } = await import(packageName);
  return puppeteer.connect({
    browserWSEndpoint: endpoint,
    defaultViewport: null,
  });
}
export async function waitForBrowserEndpoint(
  profile: string,
  timeoutMs = 60000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [port, path] = (
        await readFile(join(profile, "DevToolsActivePort"), "utf8")
      )
        .trim()
        .split("\n");
      if (/^\d+$/.test(port) && path?.startsWith("/devtools/browser/"))
        return "ws://127.0.0.1:" + port + path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  throw new Error(
    `Chrome control connection was not ready within ${timeoutMs / 1000}s; inspect browser.log`,
  );
}
export async function attachBrowser(
  world: WorldHandle,
  accounts: Account[],
): Promise<BrowserHandle> {
  const metadata = JSON.parse(
    await readFile(join(world.dir, "browser.json"), "utf8"),
  ) as { process: OwnedProcess; endpoint: string };
  if (!(await ownsProcess(metadata.process)))
    throw new Error("rendered browser is not running");
  const browser = await connect(metadata.endpoint);
  async function page(id: string): Promise<Page> {
    const a = accounts.find((a) => a.agentId === id);
    if (!a) throw new Error("unknown agent");
    const matches = (await browser.pages()).filter(
      (p) => botName(p, world.gameUrl) === a.username,
    );
    if (matches.length !== 1)
      throw new Error("character tab missing or duplicated");
    return matches[0];
  }
  return {
    focus: async (id) => (await page(id)).bringToFront(),
    capture: async (id) =>
      Buffer.from(await (await page(id)).screenshot({ type: "png" })),
    captureGame: async (id, label) => {
      const data = await (await page(id)).evaluate(gameCanvasFrame, label);
      return Buffer.from(data.split(",")[1], "base64");
    },
    connected: async (id) => {
      try {
        return !(await page(id)).isClosed();
      } catch {
        return false;
      }
    },
    close: () => browser.disconnect(),
  };
}
export function gameCanvasFrame(label: string): string {
  const game = document.querySelector<HTMLCanvasElement>("#canvas");
  if (!game || !game.width || !game.height)
    throw new Error("Game canvas is not ready for recording");
  const frame = document.createElement("canvas");
  frame.width = game.width;
  frame.height = game.height + 42;
  const context = frame.getContext("2d");
  if (!context) throw new Error("Cannot create recording frame");
  context.fillStyle = "black";
  context.fillRect(0, 0, frame.width, frame.height);
  context.drawImage(game, 0, 42);
  context.fillStyle = "white";
  context.font = "16px sans-serif";
  context.fillText(label, 10, 26, Math.max(1, frame.width - 180));
  return frame.toDataURL("image/jpeg", 0.8);
}
export async function startBrowser(
  world: WorldHandle,
  accounts: Account[],
): Promise<BrowserHandle> {
  const metadataPath = join(world.dir, "browser.json");
  let metadata: { process: OwnedProcess; endpoint: string } | undefined;
  if (existsSync(metadataPath)) {
    const previous = JSON.parse(await readFile(metadataPath, "utf8"));
    if (await ownsProcess(previous.process)) metadata = previous;
  }
  let owned: OwnedProcess | undefined;
  try {
    if (!metadata) {
      const packageName = "puppeteer";
      const { default: puppeteer } = await import(packageName);
      const profile = join(world.dir, "browser-profile");
      await mkdir(profile, { recursive: true, mode: 0o700 });
      // DevToolsActivePort may be stale after a browser exit; use a fresh profile for a new process.
      const sessionProfile = join(profile, randomBytes(8).toString("hex"));
      await mkdir(sessionProfile);
      const executable =
        process.env.CHROMIUM_PATH || puppeteer.executablePath();
      owned = await spawnOwned(
        executable,
        [
          "--user-data-dir=" + sessionProfile,
          "--remote-debugging-port=0",
          "--remote-debugging-address=127.0.0.1",
          "--no-first-run",
          "about:blank",
        ],
        world.dir,
        join(world.dir, "browser.log"),
      );
      console.error(
        "[browser] Waiting up to 60s for Chrome's control connection...",
      );
      const endpoint = await waitForBrowserEndpoint(sessionProfile);
      metadata = { process: owned, endpoint };
      await writeJson(metadataPath, metadata);
    }
    console.error("[browser] Connecting to Chrome...");
    const browser = await connect(metadata.endpoint);
    try {
      await ensureTabs(browser, world.gameUrl, accounts);
    } finally {
      await browser.disconnect();
    }
    return attachBrowser(world, accounts);
  } catch (e) {
    console.error(
      "[browser] Startup failed:",
      e instanceof Error ? e.message : String(e),
    );
    if (owned && (await ownsProcess(owned))) {
      try {
        await stopOwned(owned);
      } catch (cleanupError) {
        throw new AggregateError(
          [e, cleanupError],
          "Browser startup failed and Chrome did not shut down; close its window manually.",
        );
      }
    }
    throw e;
  }
}
