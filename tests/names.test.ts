import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { allocateNames } from "../src/names.ts";

test("name allocations are unique across worlds and stable on restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-names-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "names.sqlite"),
    db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE names(name_key TEXT PRIMARY KEY,display_name TEXT NOT NULL)",
  );
  for (const [key, display] of [
    ["some_name", "Some Name"],
    ["zezima", "Zezima"],
    ["alice", "Alice"],
  ])
    db.prepare("INSERT INTO names VALUES(?,?)").run(key, display);
  db.close();
  const first = allocateNames(path, "world1", ["a", "b"]);
  assert.equal(new Set(first.map((n) => n.username)).size, 2);
  assert.deepEqual(allocateNames(path, "world1", ["a", "b"]), first);
  const second = allocateNames(path, "world2", ["a"]);
  assert.ok(!first.some((n) => n.username === second[0].username));
  assert.throws(() => allocateNames(path, "world3", ["a"]), /pool exhausted/);
  assert.throws(() => allocateNames(path, "world1", ["different"]), /roster/);
});
