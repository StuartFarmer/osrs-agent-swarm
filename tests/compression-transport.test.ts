import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { compressionTransport } from "../src/compression-transport.ts";

test("billion-context can forward only one uncapped model call per reservation", async t => {
  const statuses: number[] = [];
  const received: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url?.startsWith("/denied/")) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { metadata: { limit_source: req.url.split("/")[2] } } }));
      return;
    }
    if (req.url === "/upstream") {
      received.push({ body, auth: req.headers.authorization });
    } else {
      const relay = req.url!.slice("/bili/".length);
      assert.notEqual(req.headers.authorization, "Bearer mock-upstream-key");
      for (let i = 0; i < 2; i++) {
        const response = await fetch(relay, {
          method: "POST", headers: { authorization: req.headers.authorization! },
          body: JSON.stringify({ ...body, provider: { sort: "latency" } }),
        });
        statuses.push(response.status);
        await response.text();
      }
    }
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  try { await once(server, "listening"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EPERM") return t.skip("sandbox denies loopback listeners");
    throw e;
  }
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const transport = await compressionTransport();
  t.after(() => transport.close());
  for (const limits of [{ max_tokens: 1 }, { max_completion_tokens: 1 }, {}]) {
    const request = transport.request(origin, {});
    try {
      const response = await request.fetch(origin + "/upstream", {
        method: "POST", headers: { authorization: "Bearer mock-upstream-key" },
        body: JSON.stringify({ model: "mock", stream: true, messages: [], tools: [{ function: { name: "compress" } }],
          provider: { sort: "price" }, ...limits }),
      });
      await response.text();
      assert.equal(request.dispatched, !Object.keys(limits).length);
    } finally { request.close(); }
  }
  assert.deepEqual(statuses, [502, 403, 502, 403, 200, 403]);
  for (const [source, expected] of [
    ["openrouter_key_limit", "key_limit"], ["openrouter_credits", "funding"], ["openrouter_in_flight_budget", "in_flight"],
  ]) {
    const request = transport.request(origin, {});
    const response = await request.fetch(origin + "/denied/" + source, {
      method: "POST", body: JSON.stringify({model:"mock",stream:true,messages:[],tools:[{function:{name:"compress"}}]}),
    });
    await response.text();
    assert.equal(request.creditError, expected);
    request.close();
  }
  assert.equal(received.length, 1);
  assert.equal(received[0].auth, "Bearer mock-upstream-key");
  assert.deepEqual(received[0].body.provider, { sort: "price" });
});
