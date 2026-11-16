import { rename } from "node:fs/promises";
import { prepareWorld } from "../src/world.ts";

console.error("[image] Preparing the pinned game world and client assets...");
const world = await prepareWorld("m1");
await rename(world.dir, "/opt/swarm-world");
console.error(
  "[image] World template ready; no player accounts or inference were created.",
);
