import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import ts from "typescript";

test("viewer selection bridge accepts only its same-origin parent and releases its listener", async () => {
  const { patchViewer } = await import(
    new URL("../scripts/prepare-viewer.mjs", import.meta.url).href
  );
  const source = `export class LiveController {
    private started: boolean = false;
    pendingFollow?: string;
    followName?: string;
    world = { rosterPlayers: [] as any[], rosterTick: -1 };
    feed = { setRoster(_: boolean) {}, close() {} };
    constructor() {
        this.feed.setRoster(true);
    }
    stop(): void {
        this.feed.close();
    }
    follow(player: {name: string}) {
        this.followName = player.name;
    }
    goToPlayer(name: string) {
        this.followName = name;
    }
    update() {
        if (this.pendingFollow && this.world.rosterTick !== -1) {
            const name = this.pendingFollow;
            this.pendingFollow = undefined;
            this.goToPlayer(name);
        }
    }
}
export function getDefaultFeedUrl(): string | undefined { return undefined; }
`;
  const patched = patchViewer(source);
  assert.equal(patchViewer(patched), patched);
  assert.throws(() => patchViewer("unexpected upstream file"), /patch refused/);
  const messages: any[] = [],
    listeners = new Map<string, Function>();
  const parent = { postMessage: (...args: any[]) => messages.push(args) };
  const window = {
    parent,
    location: {
      origin: "http://localhost:16080",
      host: "localhost:16080",
      protocol: "http:",
    },
    addEventListener: (type: string, callback: Function) =>
      listeners.set(type, callback),
    removeEventListener: (type: string, callback: Function) => {
      assert.equal(listeners.get(type), callback);
      listeners.delete(type);
    },
  };
  const context = { exports: {} as any, window };
  runInNewContext(
    ts.transpileModule(patched, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    context,
  );
  const viewer = new context.exports.LiveController();
  assert.equal(messages[0][0].type, "swarm-ready");
  const message = listeners.get("message")!;
  message({
    origin: "https://evil.example",
    source: parent,
    data: { type: "swarm-follow", name: "Alice" },
  });
  message({
    origin: window.location.origin,
    source: {},
    data: { type: "swarm-follow", name: "Alice" },
  });
  message({
    origin: window.location.origin,
    source: parent,
    data: { type: "sdk_action", name: "Alice" },
  });
  assert.equal(viewer.pendingFollow, undefined);
  message({
    origin: window.location.origin,
    source: parent,
    data: { type: "swarm-follow", name: "alice_smith" },
  });
  assert.equal(viewer.pendingFollow, "alice_smith");
  viewer.world.rosterPlayers = [[1, "Bob"]];
  viewer.world.rosterTick = 1;
  viewer.update();
  assert.equal(viewer.pendingFollow, "alice_smith");
  viewer.world.rosterPlayers.push([2, "Alice Smith"]);
  viewer.update();
  assert.equal(viewer.pendingFollow, undefined);
  assert.equal(viewer.followName, "Alice Smith");
  viewer.follow({ name: "Bob" });
  assert.equal(messages.at(-1)[0].type, "swarm-selected");
  assert.equal(messages.at(-1)[0].name, "Bob");
  assert.equal(messages.at(-1)[1], window.location.origin);
  assert.equal(
    context.exports.getDefaultFeedUrl(),
    "ws://localhost:16080/worldfeed",
  );
  viewer.stop();
  assert.equal(listeners.size, 0);
});
