import { lazyApi } from "@earendil-works/pi-ai";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Store } from "./store.ts";
import type { AgentKey, ModelConfig } from "./types.ts";
export type Lease = { finish(actualUsd: number | null): void };
type Waiter = {
  key: AgentKey;
  id: string;
  upper: number;
  cap: number;
  signal: AbortSignal;
  resolve: (l: Lease) => void;
  reject: (e: unknown) => void;
  abort: () => void;
};
export class Gate {
  private active = 0;
  private queue: Waiter[] = [];
  readonly capacity: number;
  readonly store: Store;
  private readonly providerEnforcesBudget: boolean;
  constructor(capacity: number, store: Store, providerEnforcesBudget = false) {
    this.providerEnforcesBudget = providerEnforcesBudget;
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new Error("invalid concurrency");
    this.capacity = capacity;
    this.store = store;
  }
  acquire(
    key: AgentKey,
    id: string,
    upper: number,
    cap: number,
    signal: AbortSignal,
  ): Promise<Lease> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const waiter: Waiter = {
        key,
        id,
        upper,
        cap,
        signal,
        resolve,
        reject,
        abort: () => {},
      };
      waiter.abort = () => {
        this.queue = this.queue.filter((w) => w !== waiter);
        reject(signal.reason);
        this.drain();
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.queue.push(waiter);
      this.drain();
    });
  }
  private drain(): void {
    while (this.active < this.capacity && this.queue.length) {
      const w = this.queue.shift()!;
      w.signal.removeEventListener("abort", w.abort);
      if (w.signal.aborted) {
        w.reject(w.signal.reason);
        continue;
      }
      try {
        if (!this.providerEnforcesBudget) this.store.reserve(w.key, w.id, w.upper, w.cap);
      } catch (e) {
        w.reject(e);
        continue;
      }
      this.active++;
      let finished = false;
      w.resolve({
        finish: (actual) => {
          if (finished) return;
          finished = true;
          try {
            if (!this.providerEnforcesBudget) this.store.settle(w.id, actual);
          } finally {
            this.active--;
            this.drain();
          }
        },
      });
    }
  }
}
export type Provider = {
  model: Model<Api>;
  stream: StreamFn;
  upperUsd: number;
  capUsd: number;
  requestSettings?: Record<string, unknown>;
};
export function usageCost(
  usage: Usage,
  rates: ModelConfig["rates"],
): number | null {
  const fields = ["input", "output", "cacheRead", "cacheWrite"] as const;
  if (!fields.every((k) => Number.isFinite(usage[k]) && usage[k] >= 0))
    return null;
  // Pi's input/output/cache counters are disjoint; reasoning is a subset of output.
  if (fields.every((k) => usage[k] === 0)) return null;
  return fields.reduce((n, k) => n + (usage[k] * rates[k]) / 1000000, 0);
}
export function createProvider(config: ModelConfig): Provider {
  if (!["openai-compatible", "openrouter"].includes(config.provider))
    throw new Error(
      "POC supports openai-compatible or openrouter Chat Completions",
    );
  if (
    config.provider === "openrouter" &&
    config.baseUrl !== "https://openrouter.ai/api/v1"
  )
    throw new Error("OpenRouter requires its explicit official API endpoint");
  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey)
    throw new Error(
      "Missing model credential environment variable: " + config.apiKeyEnv,
    );
  const model: Model<"openai-completions"> = {
    id: config.modelId,
    name: config.modelId,
    api: "openai-completions",
    provider: config.provider,
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: config.rates,
    contextWindow: config.contextWindow,
    maxTokens: config.contextWindow,
    compat: {
      maxTokensField: "max_tokens",
      supportsStore: false,
      supportsDeveloperRole: false,
    },
  };
  const api = lazyApi(
    () => import("@earendil-works/pi-ai/api/openai-completions"),
  );
  const requestSettings =
    config.provider === "openrouter"
      ? {
          reasoning: { enabled: false },
          provider: {
            allow_fallbacks: false,
            require_parameters: true,
            sort: "price",
            max_price: {
              prompt: config.rates.input,
              completion: config.rates.output,
              request: 0,
            },
          },
        }
      : undefined;
  return {
    model,
    requestSettings,
    capUsd: config.costLimitUsd,
    // Input and completion share the context window. Reserve at the highest tariff.
    upperUsd: config.contextWindow * Math.max(...Object.values(config.rates)) / 1_000_000,
    stream: (m, c, o) =>
      api.stream(m, c, {
        ...o,
        maxTokens: undefined,
        apiKey,
        maxRetries: 0,
        ...(requestSettings
          ? {
              onPayload: (payload: unknown) => ({
                ...(payload as Record<string, unknown>),
                ...requestSettings,
              }),
            }
          : {}),
      }),
  };
}
