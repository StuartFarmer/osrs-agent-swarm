import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readWorld, writeJson, SDK_REVISION } from "../../src/world.ts";
import { startBrowser, accountsFor } from "../../src/browser.ts";
import type { BrowserHandle } from "../../src/browser.ts";
import { connectGame } from "../../src/game.ts";
import type { GameClient, GameAction } from "../../src/game.ts";
import { verifyRuntime, acquireWorldLock } from "../../src/run.ts";
import { Store } from "../../src/store.ts";
import { Trace } from "../../src/trace.ts";
import { json } from "../../src/agent-definition.ts";

test(
  "three rendered characters: public/DM isolation, follow, trade and pickup",
  {
    skip:
      process.env.SWARM_LIVE_GAME !== "1"
        ? "set SWARM_LIVE_GAME=1 after preparing a disposable smoke world"
        : false,
    timeout: 300000,
  },
  async () => {
    console.error("[smoke] Checking runtime and loading world...");
    verifyRuntime();
    const world = await readWorld(process.env.SWARM_SMOKE_WORLD ?? "m1smoke"),
      release = await acquireWorldLock(world.dir);
    let browser: BrowserHandle | undefined;
    let store: Store | undefined;
    const games: GameClient[] = [];
    try {
      const entries = ["alice", "bob", "carol"].map((id) => ({
        id,
        definition: "gatherer" as const,
        profilePath: "unused",
        instructionsPath: "unused",
      }));
      console.error("[smoke] Opening three rendered clients...");
      const accounts = await accountsFor(world, entries);
      browser = await startBrowser(world, accounts);
      const runId = "smoke-" + randomUUID(),
        dir = join(world.dir, runId);
      await mkdir(dir);
      const database = (store = new Store(join(dir, "state.sqlite"))),
        trace = new Trace(dir, database, 1073741824);
      const checks: Record<string, boolean> = {},
        signal = AbortSignal.timeout(280000);
      const key = (i: number) => ({
        runId,
        worldId: world.id,
        agentId: entries[i].id,
      });
      async function until(condition: () => boolean, ms = 15000) {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          signal.throwIfAborted();
          if (condition()) return;
          await delay(100);
        }
        throw new Error("game effect was not observed before timeout");
      }
      async function act(
        i: number,
        action: Omit<GameAction, "stamp"> | Record<string, unknown>,
      ) {
        console.error(`[smoke] ${entries[i].id}: ${action.kind}`);
        const a = { ...action, stamp: games[i].observe().stamp } as GameAction,
          id = randomUUID();
        database.beginAction(key(i), id, json(a));
        await trace.flush(key(i));
        const outcome = await games[i].execute(a, signal);
        database.endAction(key(i), id, outcome);
        await trace.flush(key(i));
        assert.ok(
          ["completed", "dispatched"].includes(outcome.status),
          outcome.message,
        );
      }
      const state = (i: number) => games[i].observe().raw;
      const messages = (i: number, needle: string) =>
        JSON.stringify(state(i).gameMessages)
          .toLowerCase()
          .includes(needle.toLowerCase());
      const count = (i: number, id: number) =>
        state(i)
          .inventory.filter((x) => x.id === id)
          .reduce((sum, x) => sum + x.count, 0);
      try {
        for (let i = 0; i < 3; i++) {
          console.error(`[smoke] Connecting ${entries[i].id}...`);
          const g = await connectGame(key(i), accounts[i], world);
          games.push(g);
          console.error(
            `[smoke] Waiting for ${entries[i].id} to enter the game...`,
          );
          await g.ready(signal);
          console.error(
            `[smoke] Preparing ${entries[i].id} (tutorial skip)...`,
          );
          await g.prepare?.(signal);
        }
        console.error(
          "[smoke] Waiting for all three characters to see each other...",
        );
        await until(() =>
          games.every((g) => g.observe().raw.nearbyPlayers.length >= 2),
        );
        const publicText = "swarm public " + randomUUID().slice(0, 8);
        await act(0, { kind: "say", text: publicText });
        await until(() => messages(1, publicText) && messages(2, publicText));
        checks.publicChat = true;
        await delay(800);
        const privateText = "swarm private " + randomUUID().slice(0, 8);
        await act(0, {
          kind: "dm",
          targetName: accounts[1].username,
          text: privateText,
        });
        await until(() => messages(1, privateText));
        await delay(1200);
        assert.equal(messages(2, privateText), false);
        checks.dmIsolation = true;

        const bob = state(0).nearbyPlayers.find(
          (p) =>
            p.name.toLowerCase().replaceAll(" ", "_") === accounts[1].username,
        )!;
        const before = state(0).player!;
        await act(0, {
          kind: "follow",
          player: { index: bob.index, name: bob.name },
        });
        await act(1, { kind: "walk", x: before.worldX + 5, z: before.worldZ });
        await until(
          () =>
            state(0).player!.worldX !== before.worldX ||
            state(0).player!.worldZ !== before.worldZ,
        );
        await act(0, { kind: "stop_follow" });
        await delay(1600);
        const stopped = {
          x: state(0).player!.worldX,
          z: state(0).player!.worldZ,
        };
        await act(1, { kind: "walk", x: stopped.x + 5, z: stopped.z });
        await delay(2400);
        assert.deepEqual(
          { x: state(0).player!.worldX, z: state(0).player!.worldZ },
          stopped,
        );
        checks.followStop = true;
        await act(1, { kind: "walk", x: stopped.x, z: stopped.z });
        await until(() => Math.abs(state(1).player!.worldX - stopped.x) <= 1);

        const item = state(0).inventory.find((x) => x.count > 0);
        assert.ok(item, "smoke requires one transferable inventory item");
        const initial = count(0, item.id);
        await act(0, {
          kind: "drop",
          item: { slot: item.slot, id: item.id },
          count: item.count,
        });
        await until(() => count(0, item.id) === initial - item.count);
        await until(() => state(0).groundItems.some((x) => x.id === item.id));
        const ground = state(0).groundItems.find((x) => x.id === item.id)!;
        await act(0, {
          kind: "pickup",
          target: { id: ground.id, x: ground.x, z: ground.z },
        });
        await until(() => count(0, item.id) === initial);
        checks.dropPickup = true;

        const peer = (i: number, j: number) => {
          const p = state(i).nearbyPlayers.find(
            (x) =>
              x.name.toLowerCase().replaceAll(" ", "_") ===
              accounts[j].username,
          );
          assert.ok(p);
          return { index: p.index, name: p.name };
        };
        const aliceBefore = count(0, item.id),
          bobBefore = count(1, item.id);
        await act(0, { kind: "trade_request", player: peer(0, 1) });
        await delay(800);
        await act(1, { kind: "trade_request", player: peer(1, 0) });
        await until(() => !!state(0).trade?.isOpen && !!state(1).trade?.isOpen);
        const offered = state(0).inventory.find((x) => x.id === item.id)!;
        const current = state(0).trade!;
        await act(0, {
          kind: "trade_offer",
          partner: current.partner,
          give: [],
          receive: [],
          item: { id: offered.id, slot: offered.slot },
          count: 1,
        });
        await until(
          () =>
            state(1).trade?.theirOffer.some(
              (x) => x.id === item.id && x.count === 1,
            ) === true,
        );
        for (const screen of ["offer", "confirm"]) {
          await until(
            () =>
              state(0).trade?.screen === screen &&
              state(1).trade?.screen === screen,
          );
          for (let i = 0; i < 2; i++) {
            const trade = state(i).trade!;
            await act(i, {
              kind: "trade_accept",
              partner: trade.partner,
              screen,
              give: i === 0 ? [{ id: item.id, count: 1 }] : [],
              receive: i === 1 ? [{ id: item.id, count: 1 }] : [],
            });
          }
        }
        await until(() => !state(0).trade?.isOpen && !state(1).trade?.isOpen);
        assert.equal(count(0, item.id), aliceBefore - 1);
        assert.equal(count(1, item.id), bobBefore + 1);
        checks.tradeDeltas = true;
        const path = await trace.capture(
          key(0),
          randomUUID(),
          await browser.capture("alice"),
        );
        database.append(key(0), { type: "screenshot", data: { path } });
      } finally {
        await writeJson(join(world.dir, "social-smoke.json"), {
          mode: "live",
          revision: SDK_REVISION,
          at: new Date().toISOString(),
          runId,
          evidenceDir: dir,
          checks,
        });
      }
      console.error("[smoke] All social checks passed; screenshot saved.");
    } catch (error) {
      console.error(
        "[smoke] Failed:",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    } finally {
      await Promise.allSettled(games.map((g) => g.close()));
      try {
        await browser?.close();
      } finally {
        try {
          store?.close();
        } finally {
          await release();
        }
      }
    }
  },
);
