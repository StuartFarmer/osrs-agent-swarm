import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { TObject } from "typebox";
import type { AgentKey } from "./types.ts";
import { compressionTransport } from "./compression-transport.ts";

type Manifest = {
  proxy: string;
  protocolVersion: number;
  tools: { anthropic: { name: string; description: string; input_schema: TObject }[] };
};
const contextTools = ["compress", "decompress", "search_context", "acp_status"];

export async function startBillionContext(dir: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const home = join(dir, "billion-context");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  await new Promise<void>((resolve, reject) => socket.close(e => e ? reject(e) : resolve()));

  const origin = `http://127.0.0.1:${address.port}`;
  const cli = join(dirname(fileURLToPath(import.meta.resolve("billion-context/package.json"))), "dist/index.js");
  const child = spawn(process.execPath, [cli, "start", "--host", "127.0.0.1", "--port", String(address.port)], {
    cwd: home,
    stdio: "ignore",
    env: {
      PATH: process.env.PATH, HOME: home,
      ACP_AUTO_UPDATE: "0", BILI_ADVISORY_CHECK: "0", BILI_MITM: "0",
      BILI_CACHE_KEEPALIVE: "0", BILI_REPLAY_RETRY_MAX: "1",
    },
  });
  const exited = once(child, "close");
  void exited.catch(() => {});
  async function close() {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  try {
    const startup = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    for (;;) {
      startup.throwIfAborted();
      if (!child.pid || child.exitCode !== null || child.signalCode !== null)
        throw new Error("billion-context exited during startup");
      const health = await fetch(`${origin}/__bili/health`, { signal: startup })
        .then(r => r.ok ? r.json() : undefined).catch(() => undefined);
      if (health?.ok && health.pid === child.pid) break;
      await delay(100, undefined, { signal: startup });
    }
    const manifest = await fetch(`${origin}/__bili/plugin/manifest`, { signal: startup })
      .then(r => { if (!r.ok) throw new Error(`billion-context manifest HTTP ${r.status}`); return r.json() as Promise<Manifest>; });
    if (manifest.proxy !== "billion-context" || manifest.protocolVersion !== 1)
      throw new Error("Unsupported billion-context plugin protocol");
    const schemas = contextTools.map(name => {
      const schema = manifest.tools.anthropic.find(t => t.name === name);
      if (!schema) throw new Error(`billion-context missing tool ${name}`);
      if (name === "decompress") delete schema.input_schema.properties.toFile;
      return { ...schema, input_schema: { ...schema.input_schema, additionalProperties: false } };
    });
    const transport = await compressionTransport();
    return {
      async close() { try { await close(); } finally { await transport.close(); } },
      agent(key: AgentKey, model: Model<Api>) {
        const conversationId = [key.runId, key.worldId, key.agentId].join("/");
        const headers = {
          "x-bili-plugin": "pi", "x-bili-plugin-conversation": conversationId,
          "x-bili-plugin-context-window": String(model.contextWindow), "x-bili-plugin-model": model.id,
        };
        const tools: AgentTool[] = schemas.map(schema => ({
          name: schema.name, label: schema.name, description: schema.description, parameters: schema.input_schema,
          async execute(_id, args, signal) {
            if (!args || typeof args !== "object" || Object.keys(args).some(k => !Object.hasOwn(schema.input_schema.properties, k)))
              throw new Error(`Unknown argument for ${schema.name}`);
            const response = await fetch(`${origin}/__bili/plugin/tool`, {
              method: "POST", headers: { "content-type": "application/json" }, signal,
              body: JSON.stringify({ conversationId, nativeCaller: true, tool: schema.name, args }),
            });
            const result = await response.json();
            if (!response.ok || !result.ok || typeof result.result !== "string")
              throw new Error(result.error ?? `billion-context tool HTTP ${response.status}`);
            return { content: [{ type: "text", text: result.result }], details: { conversationId } };
          },
        }));
        return { request: () => transport.request(origin, headers), conversationId, tools };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
export type BillionContextAgent = ReturnType<Awaited<ReturnType<typeof startBillionContext>>["agent"]>;
