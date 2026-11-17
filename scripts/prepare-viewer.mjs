import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

export function patchViewer(source) {
  if (source.includes("private swarmSelect")) return source;
  function replace(before, after) {
    if (source.split(before).length !== 2)
      throw new Error("Pinned viewer changed; bridge patch refused");
    source = source.replace(before, after);
  }
  replace(
    "    private started: boolean = false;",
    `    private started: boolean = false;
    private swarmSelect = (event: MessageEvent): void => {
        if (event.origin !== window.location.origin || event.source !== window.parent || window.parent === window) return;
        if (event.data?.type !== "swarm-follow" || typeof event.data.name !== "string" || !/^[a-zA-Z0-9_ ]{1,12}$/.test(event.data.name)) return;
        this.pendingFollow = event.data.name;
    };
    private swarmSelected(name: string): void {
        if (window.parent !== window) window.parent.postMessage({ type: "swarm-selected", name }, window.location.origin);
    }`,
  );
  replace(
    "        this.feed.setRoster(true);",
    `        this.feed.setRoster(true);
        window.addEventListener("message", this.swarmSelect);
        if (window.parent !== window) window.parent.postMessage({ type: "swarm-ready" }, window.location.origin);`,
  );
  replace(
    "    stop(): void {\n        this.feed.close();",
    `    stop(): void {
        window.removeEventListener("message", this.swarmSelect);
        this.feed.close();`,
  );
  replace(
    "        this.followName = player.name;",
    "        this.followName = player.name;\n        this.swarmSelected(player.name);",
  );
  replace(
    "        this.followName = name;",
    "        this.followName = name;\n        this.swarmSelected(name);",
  );
  // Keep a selected offline character pending until a later roster actually contains it.
  replace(
    "if (this.pendingFollow && this.world.rosterTick !== -1) {\n            const name = this.pendingFollow;",
    `const pendingPlayer = this.pendingFollow && this.world.rosterPlayers.find(
            p => p[1].toLowerCase().replace(/ /g, "_") === this.pendingFollow!.toLowerCase().replace(/ /g, "_"),
        );
        if (pendingPlayer) {
            const name = pendingPlayer[1];`,
  );
  const start = source.indexOf(
    "export function getDefaultFeedUrl(): string | undefined {",
  );
  if (start < 0) throw new Error("Missing viewer feed default");
  source =
    source.slice(0, start) +
    `export function getDefaultFeedUrl(): string | undefined {
    return (window.location.protocol === "https:" ? "wss://" : "ws://") + window.location.host + "/worldfeed";
}\n`;
  return source;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = resolve(process.argv[2] ?? "references/rs-world");
  const pin = (
    await readFile(new URL("./viewer-revision.txt", import.meta.url), "utf8")
  ).trim();
  const revision = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (revision !== pin) throw new Error("Viewer revision mismatch");
  const path = join(root, "src/live/LiveController.ts");
  await writeFile(path, patchViewer(await readFile(path, "utf8")));
}
