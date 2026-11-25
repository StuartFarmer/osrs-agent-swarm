import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Store } from "./store.ts";

export type KeyBalance = {
  spentUsd: number;
  remainingUsd: number;
  limitUsd: number;
  checkedAt: string;
};

export async function refreshKeyBalance(
  store: Store,
  apiKey: string,
  limitUsd: number,
  signal: AbortSignal,
) {
  const fingerprint = createHash("sha256").update(apiKey).digest("hex");
  const previous = store.keyBalance();
  if (previous && previous.fingerprint !== fingerprint)
    throw new Error("Resume with the original OpenRouter key for this run");
  for (;;) {
    signal.throwIfAborted();
    let response: Response | undefined;
    try {
      response = await fetch("https://openrouter.ai/api/v1/key", {
        headers: { Authorization: "Bearer " + apiKey },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      });
    } catch {
      signal.throwIfAborted();
    }
    if (!response || response.status === 429 || response.status >= 500) {
      await response?.body?.cancel();
      await delay(5000, undefined, { signal });
      continue;
    }
    if (!response.ok)
      throw new Error(
        "OpenRouter key verification returned HTTP " + response.status,
      );
    const { data } = await response.json();
    if (data?.limit !== limitUsd || data.limit_reset !== null)
      throw new Error(
        "Use a dedicated OpenRouter key with a $" +
          limitUsd +
          " credit limit and no reset",
      );
    if (
      !Number.isFinite(data.usage) ||
      data.usage < 0 ||
      !Number.isFinite(data.limit_remaining)
    )
      throw new Error("OpenRouter returned an invalid usage balance");
    if (!previous && (data.usage !== 0 || data.limit_remaining !== limitUsd))
      throw new Error(
        "A new experiment requires an unused dedicated OpenRouter key",
      );
    const balance: KeyBalance = {
      spentUsd: data.usage,
      remainingUsd: data.limit_remaining,
      limitUsd,
      checkedAt: new Date().toISOString(),
    };
    store.saveKeyBalance(fingerprint, balance);
    return balance;
  }
}
