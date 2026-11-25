export type Offer = {
  owner: string;
  item: number;
  side: "buy" | "sell";
  remaining: number;
  price: number;
  items: number;
  coins: number;
};

export type Holdings = { coins: number; items: Record<number, number> };

// Recover every open order and claim before hypothetically selling into the other bids.
// Each character is valued independently against the same price/time ordered book.
export function liquidate(owner: string, holdings: Holdings, offers: Offer[]) {
  let cash = holdings.coins,
    saleProceeds = 0;
  const items = { ...holdings.items };
  for (const o of offers) {
    if (o.owner !== owner) continue;
    cash += o.coins + (o.side === "buy" ? o.remaining * o.price : 0);
    const amount = o.items + (o.side === "sell" ? o.remaining : 0);
    if (amount) items[o.item] = (items[o.item] ?? 0) + amount;
  }
  const quantities = { ...items };
  const gross = new Map<number, number>();
  for (const bid of offers) {
    if (bid.side !== "buy" || bid.owner === owner || !items[bid.item]) continue;
    const fill = Math.min(items[bid.item], bid.remaining);
    gross.set(bid.item, (gross.get(bid.item) ?? 0) + fill * bid.price);
    items[bid.item] -= fill;
    if (!items[bid.item]) delete items[bid.item];
  }
  for (const amount of gross.values())
    saleProceeds += amount - Math.floor(amount / 20);
  if (!Number.isSafeInteger(cash + saleProceeds))
    throw new Error("Invalid liquidation total");
  return {
    cash,
    saleProceeds,
    wealth: cash + saleProceeds,
    unsold: items,
    quantities,
  };
}

export type WealthSnapshot = {
  tick: number;
  deaths?: Record<string, { tick: number; cause: string; time: number }>;
  players: Record<
    string,
    Omit<ReturnType<typeof liquidate>, "quantities"> & {
      assets: Record<number, { name: string; count: number }>;
    }
  >;
};

export function wealthGini(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return sum
    ? sorted.reduce((v, x, i) => v + (2 * i + 1 - sorted.length) * x, 0) /
        (sum * sorted.length)
    : null;
}
