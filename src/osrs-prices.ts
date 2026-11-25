import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJson } from "./world.ts";

const origin = "https://prices.runescape.wiki/api/v1/osrs";
type Price = { name: string; low: number; lowTime: number };
export type FrozenPrices = {
  source: string;
  retrievedAt: number;
  prices: Record<number, Price>;
  error?: string;
};

export async function runPrices(
  dir: string,
  started: boolean
): Promise<FrozenPrices> {
  const path = join(dir, "osrs-prices.json");
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const snapshot: FrozenPrices = {
    source: origin,
    retrievedAt: Date.now(),
    prices: {},
  };
  if (started) return { ...snapshot, error: "No price snapshot at run start" };
  const read = async (resource: string) => {
    const r = await fetch(origin + resource, {
      headers: {
        "User-Agent":
          "osrs-bot-swarm/1.0 (private game economy research, one snapshot per run)",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error("OSRS price service HTTP " + r.status);
    return r.json();
  };
  try {
    const [mapping, latest] = await Promise.all([
      read("/mapping"),
      read("/latest"),
    ]);
    for (const { id, name } of mapping) {
      const p = latest.data[id];
      if (
        typeof name === "string" &&
        Number.isSafeInteger(id) &&
        Number.isSafeInteger(p?.low) &&
        p.low > 0 &&
        Number.isSafeInteger(p.lowTime) &&
        p.lowTime > 0
      )
        snapshot.prices[id] = { name, low: p.low, lowTime: p.lowTime };
    }
    if (!Object.keys(snapshot.prices).length)
      throw new Error("No OSRS sell-side prices");
  } catch (e) {
    snapshot.prices = {};
    snapshot.error = e instanceof Error ? e.message : String(e);
  }
  snapshot.retrievedAt = Date.now();
  await writeJson(path, snapshot);
  return snapshot;
}

export function osrsValue(
  cash: number,
  assets: Record<number, { name: string; count: number }>,
  snapshot: FrozenPrices
) {
  if (snapshot.error) return null;
  let coveredValue = cash;
  const uncovered: Record<number, number> = {};
  for (const [key, item] of Object.entries(assets)) {
    const price = snapshot.prices[Number(key)];
    if (
      price &&
      price.name.trim().toLowerCase() === item.name.trim().toLowerCase()
    )
      coveredValue += item.count * price.low;
    else uncovered[Number(key)] = item.count;
  }
  return {
    coveredValue,
    uncovered,
    total: Object.keys(uncovered).length ? null : coveredValue,
  };
}
