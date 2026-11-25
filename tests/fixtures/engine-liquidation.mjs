// Run from a disposable prepared engine with engine-wealth.mjs installed under src/web/.
import assert from "node:assert/strict";
process.env.GE_DATABASE = ":memory:";
process.env.SWARM_WEALTH_TOKEN = "fixture";
const { default: World } = await import("#/engine/World.js");
const { default: Player } = await import("#/engine/entity/Player.js");
const { default: ObjType } = await import("#/cache/config/ObjType.js");
const { default: InvType } = await import("#/cache/config/InvType.js");
const { marketStore } = await import("#/engine/market/MarketStore.js");
const { noteFor } = await import("#/engine/market/MarketCatalog.js");
const { wealthResponse } = await import("#/web/engine-wealth.mjs");
InvType.load("data/pack");
ObjType.load("data/pack");
const coins = ObjType.getId("coins"),
  logs = ObjType.getId("logs");
const buyer = new Player("buyer", 1n, 1n),
  seller = new Player("seller", 2n, 2n);
World.players[1] = buyer;
World.players[2] = seller;
buyer.invAdd(InvType.INV, coins, 35);
seller.invAdd(InvType.getId("bank"), logs, 7);
seller.invAdd(InvType.INV, noteFor(logs), 3);
const inv = buyer.getInventory(InvType.INV);
marketStore().place(
  {
    owner: buyer.username,
    take: (id, count) => assert.equal(inv.remove(id, count), count),
    save: () => new Uint8Array(),
    rollback() {},
  },
  logs,
  "buy",
  3,
  10,
  coins
);
const request = new Request("http://localhost/", {
  headers: { Authorization: "Bearer fixture" },
});
const { players } = await wealthResponse(request).json();
assert.equal(players.buyer.cash, 35);
assert.deepEqual(players.seller, {
  cash: 0,
  saleProceeds: 29,
  wealth: 29,
  unsold: { [logs]: 7 },
  assets: { [logs]: { name: "Logs", count: 10 } },
});
process.env.SWARM_PERMADEATH = "1";
const { recordDeath } = await import("#/web/engine-deaths.mjs");
recordDeath("buyer", 100, "player_death");
recordDeath("buyer", 110, "duplicate");
const afterDeath = await wealthResponse(request).json();
assert.equal(afterDeath.deaths.buyer.tick, 100);
assert.equal(afterDeath.players.buyer.cash, 35);
assert.equal(afterDeath.players.seller.saleProceeds, 0);
assert.equal(marketStore().db.query("SELECT state FROM offers WHERE owner='buyer'").get().state, "cancelled");
console.log("Bank, notes, escrow, executable bids, tax and death cancellation verified.");
process.exit(0);
