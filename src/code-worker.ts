import { fork, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createGame, type GameClient, type RawState } from "./game.ts";
import { identifier } from "./config.ts";
import type { AgentKey } from "./types.ts";

export class WorkerRpc {
  private next = 0;
  private stopped = false;
  private pending = new Map<
    number,
    { resolve(value: any): void; reject(error: Error): void }
  >();
  private exited: Promise<void>;
  private child: ChildProcess;
  constructor(child: ChildProcess, onState: (value: any) => void = () => {}) {
    this.child = child;
    this.exited = new Promise((resolve) =>
      child.once("close", () => resolve()),
    );
    const fail = (error: Error) => {
      this.stopped = true;
      onState({ raw: null, receivedAt: 0, seq: 0 });
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    };
    child.once("error", fail);
    child.once("exit", () =>
      fail(
        new Error("SDK worker exited; inspect state before retrying effects"),
      ),
    );
    child.on("message", (message: any) => {
      if (message.state) onState(message.state);
      const request = this.pending.get(message.id);
      if (!request) return;
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.value);
    });
  }
  async call(
    method: string,
    params: unknown,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<any> {
    signal.throwIfAborted();
    if (this.stopped) throw new Error("SDK worker closed");
    const id = ++this.next;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      if (this.child.connected) this.child.send({ cancel: id });
      // A CPU-bound script cannot handle cancellation; stop its process before releasing the call.
      killTimer ??= setTimeout(() => this.child.kill("SIGKILL"), 1000);
    };
    const timer = setTimeout(cancel, timeoutMs);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.child.send({ id, method, params }, (error) => {
          if (error) reject(error);
        });
      });
    } finally {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal.removeEventListener("abort", cancel);
      this.pending.delete(id);
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 1000);
    try {
      await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function connectCodeGame(
  key: AgentKey,
  account: { username: string; password: string },
  world: { gatewayUrl: string },
  freshnessMs: number,
  signal: AbortSignal,
  root = process.cwd(),
): Promise<GameClient> {
  Object.values(key).forEach(identifier);
  const workspace = resolve(
    root,
    "runs",
    key.runId,
    "agents",
    key.worldId,
    key.agentId,
    "workspace",
  );
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  let snapshot: { raw: RawState | null; receivedAt: number; seq: number } = {
    raw: null,
    receivedAt: 0,
    seq: 0,
  };
  const child = fork(new URL("./sdk-worker.ts", import.meta.url), [], {
    execPath: process.env.BUN_PATH ?? "bun",
    execArgv: [],
    cwd: workspace,
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    // Script workers do not inherit inference credentials.
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
  });
  const rpc = new WorkerRpc(child, (value) => {
    snapshot = value;
  });
  try {
    await rpc.call(
      "connect",
      { key, account, world, freshnessMs },
      signal,
      60000,
    );
  } catch (error) {
    await rpc.close();
    throw error;
  }
  const game = createGame(
    {
      snapshot: () => snapshot,
      dispatch: async () => {
        throw new Error("Use execute_code for this agent");
      },
      close: () => rpc.close(),
    },
    freshnessMs,
  );
  game.prepare = async (signal) => {
    await rpc.call("prepare", {}, signal, 300000);
  };
  game.executeCode = (code, timeoutMs, signal, world) =>
    rpc.call("execute", { code, timeoutMs, world }, signal, timeoutMs + 2000);
  return game;
}
