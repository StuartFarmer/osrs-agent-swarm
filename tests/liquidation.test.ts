import test from "node:test";
import assert from "node:assert/strict";
import { liquidate, wealthGini, type Offer } from "../src/liquidation.ts";
import { osrsValue, runPrices } from "../src/osrs-prices.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the observer reuses the original sell prices on resume and reports partial coverage", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-prices-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fetch = t.mock.method(globalThis, "fetch", async (url: string) =>
    Response.json(
      url.endsWith("/mapping")
        ? [{ name: "Logs", id: 1511 }]
        : { data: { 1511: { low: 40, lowTime: 100, high: 60 } } }
    )
  );
  const frozen = await runPrices(dir, false);
  assert.deepEqual(await runPrices(dir, true), frozen);
  assert.equal(fetch.mock.callCount(), 2);
  const logs = { 1511: { name: "logs", count: 10 } };
  assert.deepEqual(osrsValue(5, logs, frozen), {
    coveredValue: 405,
    uncovered: {},
    total: 405,
  });
  assert.deepEqual(
    osrsValue(5, { 1511: { name: "Other", count: 2 } }, frozen),
    { coveredValue: 5, uncovered: { 1511: 2 }, total: null }
  );
});

test("GE liquidation recovers escrow and mixed claims, excludes own bids and taxes fills cumulatively", () => {
  const offer: Offer = {
    owner: "other",
    item: 1511,
    side: "buy",
    remaining: 1,
    price: 11,
    items: 0,
    coins: 0,
  };
  const offers: Offer[] = [
    { ...offer, owner: "a", remaining: 2, price: 20, items: 1, coins: 3 },
    offer,
    { ...offer, price: 10, remaining: 2 },
    { ...offer, owner: "a", side: "sell", remaining: 2, coins: 4 },
    { ...offer, owner: "a", side: "sell", remaining: 0, items: 3 },
  ];
  const result = liquidate("a", { coins: 2, items: { 1511: 1 } }, offers);
  assert.deepEqual(result, {
    cash: 49,
    saleProceeds: 30,
    wealth: 79,
    unsold: { 1511: 4 },
    quantities: { 1511: 7 },
  });
  assert.deepEqual(liquidate("a", { coins: 3, items: { 1511: 10 } }, []), {
    cash: 3,
    saleProceeds: 0,
    wealth: 3,
    unsold: { 1511: 10 },
    quantities: { 1511: 10 },
  });
  assert.equal(wealthGini([0, 0]), null);
  assert.equal(wealthGini([10, 0]), 0.5);
});
