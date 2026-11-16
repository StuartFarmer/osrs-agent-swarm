import { connectGame, type GameClient } from "./game.ts";
import { boundedScriptResult } from "./code-tools.ts";

let game: GameClient | undefined;
let stateTimer: ReturnType<typeof setInterval> | undefined;
const active = new Map<number, AbortController>();
function publish() {
  if (!game || !process.connected) return;
  try {
    const o = game.observe();
    process.send?.({
      state: {
        raw: o.raw,
        receivedAt: o.stamp.observedAt,
        seq: o.stamp.observationSeq,
      },
    });
  } catch {
    /* State may not have arrived yet. */
  }
}
async function stop() {
  clearInterval(stateTimer);
  for (const controller of active.values()) controller.abort();
  await game?.close();
  process.exit(0);
}
process.once("SIGTERM", () => {
  void stop();
});
process.once("disconnect", () => {
  void stop();
});
process.on("message", async (message: any) => {
  if (message.cancel) {
    active.get(message.cancel)?.abort();
    return;
  }
  const { id, method, params } = message;
  const controller = new AbortController();
  active.set(id, controller);
  try {
    let value: unknown = null;
    if (method === "connect") {
      if (game) throw new Error("Already connected");
      game = await connectGame(
        params.key,
        params.account,
        params.world,
        params.freshnessMs,
        true,
      );
      stateTimer = setInterval(publish, 200);
    } else if (method === "prepare") {
      await game!.prepare!(controller.signal);
    } else if (method === "execute") {
      value = boundedScriptResult(
        await game!.executeCode!(
          params.code,
          params.timeoutMs,
          controller.signal,
          params.world,
        ),
      );
    } else throw new Error("Unknown worker operation");
    publish();
    process.send?.({ id, value });
  } catch (error) {
    process.send?.({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    active.delete(id);
  }
});
