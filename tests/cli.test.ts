import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
test("CLI rejects null model before creating a world or calling inference", () => {
  const r = spawnSync(
    process.execPath,
    ["src/cli.ts", "run", "--experiment", "experiments/m1.json"],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Explicit model/);
});
test("CLI help describes the operator commands", () => {
  const r = spawnSync(process.execPath, ["src/cli.ts", "help"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /memory/);
  assert.match(r.stdout, /capture/);
  assert.match(r.stdout, /record --run/);
  assert.match(r.stdout, /--record/);
});
