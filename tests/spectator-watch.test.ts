import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

test("3D selection and agent observations stay aligned, reject foreign messages, and discard late previous-agent state", async () => {
  const html = await readFile(
    new URL("../src/spectator-watch.html", import.meta.url),
    "utf8",
  );
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)![1];
  class Element {
    value = "";
    textContent = "";
    disabled = true;
    children: any[] = [];
    listeners: Record<string, Function> = {};
    contentWindow = {
      postMessage: (value: any, origin: string) => sent.push({ value, origin }),
    };
    replaceChildren(...children: any[]) {
      this.children = children;
      this.textContent = "";
    }
    addEventListener(type: string, listener: Function) {
      this.listeners[type] = listener;
    }
  }
  const sent: any[] = [],
    elements = new Map<string, Element>(),
    listeners = new Map<string, Function>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const agents = [
    { id: "a", name: "alice" },
    { id: "b", name: "bob" },
  ];
  let delayAlice = false,
    resolveAlice: ((value: any) => void) | undefined;
  const intervals: Function[] = [];
  const observation = (id: string) => ({
    agent: { id },
    stateAgeMs: 10,
    status: "active",
    state: {
      tick: 3,
      inventory: [{ slot: 0, name: id + " item", count: 1 }],
      gameMessages: [{ sender: "<img>", text: "<script>" }],
    },
  });
  await runInNewContext("(async () => {" + script + "})()", {
    AbortSignal,
    AbortController,
    performance: { now: () => 100 },
    location: { origin: "http://localhost:16080" },
    window: {
      addEventListener: (name: string, fn: Function) => listeners.set(name, fn),
    },
    document: {
      hidden: false,
      getElementById: element,
      createElement: () => new Element(),
    },
    Option: class {
      constructor(
        public text: string,
        public value: string,
      ) {}
    },
    setTimeout() {},
    setInterval: (fn: Function) => intervals.push(fn),
    fetch: async (url: string) => {
      if (url === "/spectator/agents")
        return { ok: true, json: async () => agents };
      const id = url.split("/").at(-1)!;
      if (id === "a" && delayAlice)
        return new Promise((resolve) => {
          resolveAlice = resolve;
        });
      return { ok: true, json: async () => observation(id) };
    },
  });
  assert.match(element("selected").textContent, /alice/);
  assert.equal(
    element("inventory").children[0].textContent,
    "Slot 0: a item × 1",
  );
  assert.equal(element("messages").children[0].textContent, "<img>: <script>");
  assert.equal(sent[0].value.name, "alice");
  const message = listeners.get("message")!;
  message({
    origin: "https://evil.example",
    source: element("scene").contentWindow,
    data: { type: "swarm-selected", name: "Bob" },
  });
  assert.match(element("selected").textContent, /alice/);

  delayAlice = true;
  const oldPoll = intervals[0]();
  message({
    origin: "http://localhost:16080",
    source: element("scene").contentWindow,
    data: { type: "swarm-selected", name: "Bob" },
  });
  await new Promise(setImmediate);
  assert.match(element("selected").textContent, /bob/);
  assert.equal(
    element("inventory").children[0].textContent,
    "Slot 0: b item × 1",
  );
  resolveAlice!({ ok: true, json: async () => observation("a") });
  await oldPoll;
  assert.equal(
    element("inventory").children[0].textContent,
    "Slot 0: b item × 1",
  );
  assert.equal(
    sent.length,
    1,
    "scene selection must not echo a follow request",
  );
  element("follow").listeners.click();
  assert.equal(sent.at(-1).value.name, "bob");
  message({
    origin: "http://localhost:16080",
    source: element("scene").contentWindow,
    data: { type: "swarm-selected", name: "outsider" },
  });
  await new Promise(setImmediate);
  assert.match(
    element("status").textContent,
    /not in the managed agent roster/,
  );
  assert.equal(element("inventory").children.length, 0);
});
