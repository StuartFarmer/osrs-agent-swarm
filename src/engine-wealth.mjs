// Installed in the pinned engine so the book and all inventories are read in one turn.
import World from "#/engine/World.js";
import Player from "#/engine/entity/Player.js";
import InvType from "#/cache/config/InvType.js";
import ObjType from "#/cache/config/ObjType.js";
import { marketStore } from "#/engine/market/MarketStore.js";
import Environment from "#/util/Environment.js";
import { deaths } from "./engine-deaths.mjs";
import { liquidate } from "./liquidation.ts";

export function wealthResponse(req) {
  if (
    !process.env.SWARM_WEALTH_TOKEN ||
    req.headers.get("Authorization") !==
      "Bearer " + process.env.SWARM_WEALTH_TOKEN
  )
    return new Response(null, { status: 403 });
  if (!Environment.GE_ENABLED)
    return new Response("GE disabled", { status: 503 });
  const offers = marketStore()
    .db.query(
      "SELECT owner,item,side,remaining,price,items,coins FROM offers WHERE slot>=0 ORDER BY price DESC,id ASC"
    )
    .all();
  const invIds = ["inv", "bank", "worn", ...Player.RECOVERABLE_INVENTORIES].map(
    (n) => InvType.getId(n)
  );
  const players = Object.create(null);
  const coinId = ObjType.getId("coins");
  for (const p of World.players) {
    if (!p) continue;
    const holdings = { coins: 0, items: {} };
    function add(item) {
      const obj = ObjType.get(item.id);
      const id = obj.certtemplate === -1 ? item.id : obj.certlink;
      if (id === coinId) holdings.coins += item.count;
      else holdings.items[id] = (holdings.items[id] ?? 0) + item.count;
    }
    for (const id of invIds) p.invs.get(id)?.itemsFiltered.forEach(add);
    p.recoveryItems.forEach(add);
    const { quantities, ...position } = liquidate(p.username, holdings, offers);
    const assets = Object.fromEntries(
      Object.entries(quantities).map(([id, count]) => [
        id,
        { name: ObjType.get(Number(id)).name ?? "", count },
      ])
    );
    players[p.username] = { ...position, assets };
  }
  const registry = deaths();
  return Response.json({ tick: World.currentTick, players, deaths: registry && Object.fromEntries(registry) });
}
