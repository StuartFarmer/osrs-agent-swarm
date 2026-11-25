import test from "node:test";
import assert from "node:assert/strict";

test("shared viewer theme scopes controls and excludes layout and text-selection resets", async () => {
  const { viewerTheme } = await import(
    new URL("../scripts/prepare-viewer.mjs", import.meta.url).href
  );
  const globalCss = `@font-face { font-family: "OSRS Bold"; src: url(./media/bold.ttf); }
@font-face { font-family: "OSRS Small"; src: url(./media/small.ttf); }
body { overflow: hidden; user-select: none; }
.rs-border { border-image: url(./media/interface-border.png) 6 / 6px repeat; }
.rs-background { background-image: url(./media/interface-bg.png); }
`;
  const panelCss = `.live-panel { position: absolute; }
.live-button { color: #ff981f; }
.live-button:hover:not(:disabled) { color: #ffff00; }
.live-button:disabled { color: #5d5447; }
.live-step .live-button { flex: 1; }
`;
  const css = viewerTheme(globalCss, panelCss);
  assert.match(css, /font-family: "OSRS Bold"/);
  assert.match(css, /\.swarm-shell \.rs-border/);
  assert.match(css, /\.swarm-shell \.live-button:hover:not\(:disabled\)/);
  assert.doesNotMatch(css, /overflow|user-select|position|live-step|flex:/);
  assert.throws(
    () => viewerTheme(globalCss.replace(".rs-border", ".changed"), panelCss),
    /theme rule changed/,
  );
  assert.throws(() => viewerTheme("", panelCss), /font rules changed/);
});
