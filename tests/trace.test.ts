import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { Trace } from "../src/trace.ts";
import { spawn, spawnSync } from "node:child_process";
const key = { runId: "r", worldId: "w", agentId: "a" };
async function setup(t: any, max = 1000000) {
  const dir = await mkdtemp(join(tmpdir(), "swarm-trace-"));
  const s = new Store(join(dir, "state.sqlite"));
  t.after(async () => {
    s.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, s, trace: new Trace(dir, s, max) };
}
test("exports once, recovers partial final line, rejects interior corruption", async (t) => {
  const { dir, s, trace } = await setup(t);
  s.append(key, { type: "hello", data: { n: 1 } });
  await trace.flush(key);
  await trace.flush(key);
  const path = join(dir, "agents/w/a/events.jsonl");
  assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 1);
  await appendFile(path, '{"partial":');
  s.append(key, { type: "hello", data: { n: 2 } });
  await trace.flush(key);
  assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 2);
  await writeFile(path, 'bad\n{"seq":2}\n');
  await assert.rejects(trace.flush(key), /corrupt/);
});
test("request files are immutable, credentials redacted, traversal rejected", async (t) => {
  const { dir, trace } = await setup(t);
  const path = await trace.context(key, "req1", {
    messages: [{ role: "user", content: "hello" }],
    apiKey: "SECRET",
    headers: { Authorization: "Bearer SECRET" },
  });
  const content = await readFile(join(dir, path), "utf8");
  assert.ok(!content.includes("SECRET"));
  assert.ok(content.includes("hello"));
  await assert.rejects(trace.context(key, "req1", { messages: [] }), /exist/);
  await assert.rejects(trace.capture(key, "../escape", Buffer.from("x")));
});
test("quota counts SQLite and blocks new journaled work", async (t) => {
  const { s, trace } = await setup(t, 1);
  await assert.rejects(trace.context(key, "r", {}), /quota/);
  assert.throws(() => s.beginAction(key, "effect", { kind: "say" }), /quota/);
  assert.equal(s.pendingActions(key).length, 0);
});
test("credentials are redacted in the SQLite recovery journal as well as exported files", async (t) => {
  const { dir, s } = await setup(t);
  new Trace(dir, s, 1000000, ["SECRET_CREDENTIAL"]);
  s.append(key, {
    type: "provider_error",
    data: {
      message: "Provider echoed SECRET_CREDENTIAL",
      apiKey: "SECRET_CREDENTIAL",
    },
  });
  assert.ok(!JSON.stringify(s.events(key)).includes("SECRET_CREDENTIAL"));
});

test("separate harness and operator processes cannot export overlapping event sequences", async (t) => {
  const { dir, s, trace } = await setup(t);
  s.append(key, { type: "one", data: null });
  await trace.flush(key);
  s.append(key, { type: "two", data: null });
  const imports =
    "import {Store} from " +
    JSON.stringify(new URL("../src/store.ts", import.meta.url).href) +
    ";" +
    "import {Trace} from " +
    JSON.stringify(new URL("../src/trace.ts", import.meta.url).href) +
    ";" +
    "const s=new Store(" +
    JSON.stringify(join(dir, "state.sqlite")) +
    ");" +
    "const t=new Trace(" +
    JSON.stringify(dir) +
    ",s,1000000);";
  const flush = "await t.flush(" + JSON.stringify(key) + ");s.close();";
  const first = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      imports +
        'const original=s.events.bind(s);let first=true;s.events=(...args)=>{if(first){first=false;process.stdout.write("reading\\n");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500)}return original(...args)};' +
        flush,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = new Promise<number | null>((resolve) =>
    first.once("exit", resolve),
  );
  await new Promise<void>((resolve, reject) => {
    first.stdout.once("data", () => resolve());
    first.once("error", reject);
  });
  const second = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", imports + flush],
    { encoding: "utf8" },
  );
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await exited, 0);
  const events = (await readFile(join(dir, "agents/w/a/events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((x) => JSON.parse(x));
  assert.deepEqual(
    events.map((e) => e.seq),
    [1, 2],
  );
});
