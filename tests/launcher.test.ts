import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("Docker launcher builds before starting, selects the 25-agent run, and keeps preview explicit", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-launcher-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, "calls");
  await writeFile(
    join(dir, "docker"),
    `#!/bin/sh
if [ "$1" = info ]; then exit "$FAIL_INFO"; fi
printf '%s|%s|%s\\n' "$*" "$SWARM_EXPERIMENT" "$SWARM_RUN_NAME" >> "$CALL_LOG"
case "$*" in *" build swarm") exit "$FAIL_BUILD" ;; esac
`,
    { mode: 0o700 },
  );
  await writeFile(
    join(dir, "sudo"),
    `#!/bin/sh
printf '%s\\n' "$1" >> "$CALL_LOG"
shift
exec "$@"
`,
    { mode: 0o700 },
  );
  const launcher = fileURLToPath(new URL("../swarm", import.meta.url));
  const env = {
    ...process.env,
    PATH: dir + ":" + process.env.PATH,
    CALL_LOG: log,
    FAIL_BUILD: "0",
    FAIL_INFO: "0",
    OPENROUTER_API_KEY: "test-secret",
    SWARM_EXPERIMENT: "",
    SWARM_RUN_NAME: "",
  };
  const run = (args: string[], extra = {}) =>
    spawnSync("bash", [launcher, ...args], {
      cwd: dir,
      env: { ...env, ...extra },
      encoding: "utf8",
      input: "",
    });
  const started = run([]);
  assert.equal(started.status, 0, started.stderr);
  assert.ok(started.stdout.includes("http://localhost:16080/watch/"));
  assert.ok(!started.stdout.includes(env.OPENROUTER_API_KEY));
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
    "compose -p swarm-headless -f compose.yaml build swarm|experiments/headless-25.json|scale25",
    "compose -p swarm-headless -f compose.yaml up -d --no-build swarm|experiments/headless-25.json|scale25",
  ]);
  await writeFile(log, "");
  assert.equal(run(["preview"], { OPENROUTER_API_KEY: "" }).status, 0);
  assert.match(await readFile(log, "utf8"), /-f compose.preview.yaml up/);
  await writeFile(log, "");
  assert.equal(run(["start"], { FAIL_BUILD: "42" }).status, 42);
  assert.ok(!(await readFile(log, "utf8")).includes(" up "));
  await writeFile(log, "");
  assert.equal(run(["logs"], { OPENROUTER_API_KEY: "" }).status, 0);
  assert.match(await readFile(log, "utf8"), /logs --tail 100 -f swarm/);
  assert.equal(run(["stop"], { OPENROUTER_API_KEY: "" }).status, 0);
  assert.match(await readFile(log, "utf8"), /stop swarm/);
  await writeFile(log, "");
  assert.equal(run(["start"], { FAIL_INFO: "1" }).status, 0);
  assert.match(
    await readFile(log, "utf8"),
    /--preserve-env=OPENROUTER_API_KEY,SWARM_EXPERIMENT,SWARM_RUN_NAME/,
  );
  assert.match(await readFile(log, "utf8"), /up -d --no-build swarm/);
  await writeFile(log, "");
  assert.equal(run(["start"], { OPENROUTER_API_KEY: "" }).status, 1);
  assert.equal(run(["unknown"]).status, 2);
  assert.equal(await readFile(log, "utf8"), "");
});
