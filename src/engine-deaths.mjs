// Runs inside the pinned game engine. Retirement and release of GE orders commit together.
import { marketStore } from "#/engine/market/MarketStore.js";

let dead;
export function deaths() {
  if (process.env.SWARM_PERMADEATH !== "1") return undefined;
  if (!dead) {
    const { db } = marketStore();
    db.exec(
      "CREATE TABLE IF NOT EXISTS swarm_deaths(owner TEXT PRIMARY KEY, tick INTEGER, cause TEXT, time INTEGER)",
    );
    dead = new Map(
      db
        .query("SELECT * FROM swarm_deaths")
        .all()
        .map((row) => [row.owner, row]),
    );
  }
  return dead;
}

export function recordDeath(owner, tick, cause) {
  const registry = deaths();
  if (!registry || registry.has(owner)) return;
  const market = marketStore();
  const time = Date.now();
  market.db
    .transaction(() => {
      market.db
        .query("INSERT INTO swarm_deaths VALUES(?,?,?,?)")
        .run(owner, tick, cause, time);
      for (const offer of market.db
        .query("SELECT id FROM offers WHERE owner=? AND state='open'")
        .all(owner))
        market.cancel(owner, offer.id);
    })
    .immediate();
  registry.set(owner, { owner, tick, cause, time });
}
