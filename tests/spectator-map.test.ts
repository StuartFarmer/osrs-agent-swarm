import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

test("spectator centers a stacked population, preserves selection, and reports stale or empty positions", async () => {
  const html = await readFile(
    new URL("../src/spectator-map.html", import.meta.url),
    "utf8",
  );
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)![1];
  class Element {
    value = "";
    textContent = "";
    disabled = true;
    replacements = 0;
    options: { text: string; value: string }[] = [];
    listeners: Record<string, () => void> = {};
    replaceChildren(...options: Element["options"]) {
      this.options = options;
      this.value = options[0]?.value ?? "";
      this.replacements++;
    }
    addEventListener(event: string, listener: () => void) {
      this.listeners[event] = listener;
    }
  }
  const elements = {
    canvas: new Element(),
    player: new Element(),
    center: new Element(),
    status: new Element(),
  };
  let map: any;
  class MapView {
    static shouldDrawPlayers = false;
    static shouldDrawHistory = true;
    playerPositions = [];
    mapOriginX = 1792;
    mapOriginZ = 2624;
    mapHeight = 3328;
    focusX = 0;
    focusZ = 0;
    constructor() {
      map = this;
    }
    updateTrails() {}
    remapZ(z: number) {
      return z === 99999 ? -1 : z;
    }
  }
  let positions = Array.from({ length: 10 }, (_, i) => ({
    name: `Player${i}`,
    x: 3094,
    z: 3106,
    level: 0,
  }));
  let fail = false;
  let malformed = false;
  await runInNewContext(
    "(async () => {" +
      script.replace('await import("/client/mapview.js")', "({ MapView: TestMapView })") +
      "})()",
    {
      TestMapView: MapView,
      AbortSignal,
      window: { innerWidth: 1200, innerHeight: 800, addEventListener() {} },
      document: { getElementById: (id: keyof typeof elements) => elements[id] },
      Option: class {
        constructor(
          public text: string,
          public value: string,
        ) {}
      },
      fetch: async (url: string) => {
        assert.equal(url, "/playerpositions");
        return {
          ok: !fail,
          status: 503,
          json: async () => (malformed ? [{ name: "bad" }] : positions),
        };
      },
    },
  );
  assert.equal(MapView.shouldDrawHistory, false);
  await map.fetchPlayerPositions();
  assert.equal(map.focusX, 1302);
  assert.equal(map.focusZ, 2846);
  assert.equal(map.zoom, 8);
  assert.equal(elements.player.options.length, 10);
  assert.match(
    elements.status.textContent,
    /10 players online.*10 on this tile/,
  );
  assert.equal(elements.center.disabled, false);

  elements.player.value = "Player5";
  elements.player.listeners.change();
  positions = positions.map((p) =>
    p.name === "Player5" ? { ...p, x: 3300, z: 3300 } : p,
  );
  await map.fetchPlayerPositions();
  assert.equal(map.focusX, 1302, "polling must not interrupt manual panning");
  assert.equal(elements.player.value, "Player5");
  assert.equal(
    elements.player.replacements,
    1,
    "polling must not rebuild an open selector",
  );
  elements.center.listeners.click();
  assert.equal(map.focusX, 1508);
  assert.equal(map.focusZ, 2652);
  assert.match(
    elements.status.textContent,
    /Player5.*x 3300, z 3300.*1 on this tile/,
  );

  fail = true;
  await map.fetchPlayerPositions();
  assert.match(elements.status.textContent, /stale.*HTTP 503/);
  assert.equal(elements.center.disabled, true);
  assert.equal(map.playerFetchPending, false);
  fail = false;
  malformed = true;
  await map.fetchPlayerPositions();
  assert.match(elements.status.textContent, /Invalid player positions/);
  malformed = false;
  positions = [];
  await map.fetchPlayerPositions();
  assert.match(elements.status.textContent, /No players reported/);
  assert.equal(elements.player.disabled, true);

  positions = [
    { name: "<img src=x onerror=alert(1)>", x: 3094, z: 99999, level: 0 },
  ];
  await map.fetchPlayerPositions();
  assert.equal(elements.player.disabled, false);
  assert.equal(elements.player.options[0].text, positions[0].name);
  elements.center.listeners.click();
  assert.match(elements.status.textContent, /outside the map/);
  assert.equal(
    map.focusX,
    1508,
    "unmapped coordinates must not move the camera",
  );
});
