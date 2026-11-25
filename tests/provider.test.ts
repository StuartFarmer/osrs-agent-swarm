import test from "node:test";
import assert from "node:assert/strict";
import { createProvider } from "../src/inference.ts";
import { loadExperiment } from "../src/config.ts";

test("OpenRouter dispatch enforces price caps, disabled reasoning and no fallback/retry", async () => {
  const previous = process.env.SWARM_PROVIDER_TEST_KEY;
  process.env.SWARM_PROVIDER_TEST_KEY = "test-only-secret";
  try {
    const provider = createProvider({
      provider: "openrouter",
      modelId: "deepseek/deepseek-v4.1-flash-1017",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeyEnv: "SWARM_PROVIDER_TEST_KEY",
      contextWindow: 65536,
      costLimitUsd: 5,
      zeroCost: false,
      rates: { input: 0.05, output: 0.5, cacheRead: 0.05, cacheWrite: 0.05 },
    });
    let calls = 0,
      body: any;
    const fakeFetch: typeof fetch = async (_url, init) => {
      calls++;
      body = JSON.parse(String(init?.body));
      const chunk = {
        id: "response1",
        object: "chat.completion.chunk",
        created: 1,
        model: provider.model.id,
        choices: [
          { index: 0, delta: { content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      };
      return new Response(
        "data: " + JSON.stringify(chunk) + "\n\ndata: [DONE]\n\n",
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    };
    const stream = await provider.stream(
      provider.model,
      { messages: [{ role: "user", content: "x".repeat(250_000), timestamp: 1 }] },
      { maxTokens: 1, fetch: fakeFetch },
    );
    for await (const _event of stream) {
    }
    const result = await stream.result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(calls, 1);
    assert.equal(Object.hasOwn(body, "max_tokens"), false);
    assert.equal(Object.hasOwn(body, "max_completion_tokens"), false);
    assert.equal(provider.upperUsd, 65536 * 0.5 / 1_000_000);
    assert.deepEqual(body.reasoning, { enabled: false });
    assert.equal(body.provider.allow_fallbacks, false);
    assert.equal(body.provider.require_parameters, true);
    assert.deepEqual(body.provider.max_price, {
      prompt: 0.05,
      completion: 0.5,
      request: 0,
    });
    assert.equal(provider.capUsd, 5);
    const config = await loadExperiment("experiments/openrouter-m1.json");
    assert.equal(config.model?.provider, "openrouter");
    assert.equal(config.model?.costLimitUsd, 5);
  } finally {
    if (previous === undefined) delete process.env.SWARM_PROVIDER_TEST_KEY;
    else process.env.SWARM_PROVIDER_TEST_KEY = previous;
  }
});
