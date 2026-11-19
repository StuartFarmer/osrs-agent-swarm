import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";

// Each paid reservation authorizes a single upstream completion. The compressor
// receives a single-use local ticket, never the provider credential.
export async function compressionTransport() {
  type Forward = (body: Record<string, unknown>) => Promise<Response>;
  const tickets = new Map<string, Forward>();
  const server = createServer(async (req, res) => {
    const ticket = req.headers.authorization ?? "";
    const forward = tickets.get(ticket);
    if (!forward || req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(403).end();
      return;
    }
    tickets.delete(ticket);
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const response = await forward(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json" });
      if (response.body) await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), res);
      else res.end();
    } catch {
      if (!res.headersSent) res.writeHead(502);
      res.end("Compressor upstream request failed");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing compressor transport address");
  return {
    close() {
      tickets.clear();
      server.closeAllConnections();
      return new Promise<void>(resolve => server.close(() => resolve()));
    },
    request(origin: string, identity: Record<string, string>) {
      let dispatched = false;
      let creditError: "key_limit" | "in_flight" | "funding" | undefined;
      let used = false;
      const ticket = `Bearer ${randomUUID()}`;
      const send: typeof fetch = async (input, init) => {
        if (used) throw new Error("Compression request already used");
        used = true;
        const request = new Request(input, init);
        const original = await request.json();
        tickets.set(ticket, async rewritten => {
          if (request.signal.aborted || rewritten.model !== original.model || rewritten.stream !== true ||
              !Array.isArray(rewritten.messages) || !Array.isArray(rewritten.tools) ||
              !rewritten.tools.some(tool => tool?.function?.name === "compress") ||
              "max_tokens" in rewritten || "max_completion_tokens" in rewritten ||
              "max_tokens" in original || "max_completion_tokens" in original)
            throw new Error("Unexpected auxiliary or output-limited compression request");
          // Preserve the harness's routing, rates, model and streaming settings.
          const headers = new Headers(request.headers);
          headers.delete("content-length");
          dispatched = true;
          const upstream = await fetch(request.url, {
            method: "POST", headers, signal: request.signal, redirect: "error",
            body: JSON.stringify({ ...original, messages: rewritten.messages, tools: rewritten.tools }),
          });
          if (upstream.status === 402 || upstream.status === 403) {
            const body = await upstream.clone().json().catch(() => null);
            const source = body?.error?.metadata?.limit_source;
            if (source === "openrouter_key_limit") creditError = "key_limit";
            else creditError = source === "openrouter_in_flight_budget" ? "in_flight" : "funding";
          }
          return upstream;
        });
        return fetch(`${origin}/bili/http://127.0.0.1:${address.port}/v1/chat/completions`, {
          method: "POST", signal: request.signal, redirect: "error",
          headers: { ...identity, authorization: ticket, "content-type": "application/json" },
          body: JSON.stringify(original),
        });
      };
      return { fetch: send, close: () => tickets.delete(ticket), get dispatched() { return dispatched; }, get creditError() { return creditError; } };
    },
  };
}
