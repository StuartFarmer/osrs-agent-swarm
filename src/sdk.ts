import type { FindOptions } from "../vendor/rs-sdk/sdk/types.ts";

const upstream: typeof import("../vendor/rs-sdk/sdk/index.ts") = await import(
  new URL("../vendor/rs-sdk/sdk/index.ts", import.meta.url).href
);

export class BotSDK extends upstream.BotSDK {
  override findNearbyNpc(pattern: string | RegExp, options?: FindOptions) {
    // shortcut: pinned skipTutorial's broad pattern picks Quest Guide; remove when upstream fixes its selector.
    if (
      pattern instanceof RegExp &&
      pattern.source === "runescape guide|guide|tutorial"
    )
      pattern = /^RuneScape Guide$/i;
    return super.findNearbyNpc(pattern, options);
  }
}
