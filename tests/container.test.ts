import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  seedContainerWorld,
  containerRunId,
  containerRunPath,
} from "../docker/state.ts";
import {
  SDK_REVISION,
  worldPath,
  startWorld,
  writeJson,
} from "../src/world.ts";
import { browserArguments } from "../src/browser.ts";

test("container seeding preserves an existing world's saves and refuses incomplete state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "swarm-container-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = join(root, "template"),
    dir = worldPath("m1", root);
  await mkdir(join(template, "game"), { recursive: true });
  await writeJson(join(template, "world.json"), {
    id: "m1",
    dir,
    gameDir: join(dir, "game"),
    revision: SDK_REVISION,
    gameUrl: "http://127.0.0.1:8888",
    gatewayUrl: "ws://127.0.0.1:7780",
    tickMs: 400,
    xpRate: 1,
  });
  await writeFile(join(template, "game", "save"), "fresh");
  await seedContainerWorld(template, "m1", root);
  assert.equal(await readFile(join(dir, "game", "save"), "utf8"), "fresh");
  await writeFile(join(dir, "game", "save"), "progress");
  await seedContainerWorld(template, "m1", root);
  assert.equal(await readFile(join(dir, "game", "save"), "utf8"), "progress");
  await rm(join(dir, "world.json"));
  await assert.rejects(seedContainerWorld(template, "m1", root), /incomplete/);
  assert.equal(await readFile(join(dir, "game", "save"), "utf8"), "progress");
});

test("container restart selects the persisted run and refuses corrupt state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "swarm-container-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pointer = join(root, "active-run.json");
  assert.equal(await containerRunId(pointer), undefined);
  await writeJson(pointer, { runId: "run-existing" });
  assert.equal(await containerRunId(pointer), "run-existing");
  await writeJson(pointer, { runId: "../outside" });
  await assert.rejects(containerRunId(pointer), /identifier/);
  await writeFile(pointer, "broken");
  await assert.rejects(containerRunId(pointer));
});

test("named container runs preserve the original run and resume their own pointer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "swarm-named-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".local"));
  const original = containerRunPath(root);
  const expanded = containerRunPath(root, "scale25");
  assert.equal(original, join(root, ".local", "container-run.json"));
  await writeJson(original, { runId: "run-ten" });
  assert.equal(await containerRunId(expanded), undefined);
  await writeJson(expanded, { runId: "run-twentyfive" });
  assert.equal(
    await containerRunId(containerRunPath(root, "scale25")),
    "run-twentyfive",
  );
  assert.equal(await containerRunId(original), "run-ten");
  assert.throws(() => containerRunPath(root, "../../escape"), /identifier/);
});

test("container Chrome flags keep the control port local and do not affect host Chrome", () => {
  const host = browserArguments("/tmp/profile", false),
    container = browserArguments("/tmp/profile", true);
  assert.ok(!host.includes("--no-sandbox"));
  assert.ok(container.includes("--no-sandbox"));
  assert.ok(container.includes("--remote-debugging-address=127.0.0.1"));
  assert.ok(container.includes("--disable-background-timer-throttling"));
});

test("cancelled container startup does not read or launch a world", async () => {
  const controller = new AbortController();
  controller.abort(new Error("container stopping"));
  await assert.rejects(
    startWorld("m1", "/missing", controller.signal),
    /container stopping/,
  );
});
