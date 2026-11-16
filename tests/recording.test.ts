import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordSession, verifyRecorder } from "../src/recording.ts";

const exec = promisify(execFile);

test(
  "Linux desktop capture produces playable video from Xvfb",
  { skip: process.platform !== "linux", timeout: 15000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "swarm-x11-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const xvfb = spawn(
      "Xvfb",
      ["-displayfd", "1", "-screen", "0", "1280x900x24", "-nolisten", "tcp"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const closed = new Promise((resolve) => xvfb.once("close", resolve));
    t.after(async () => {
      xvfb.kill("SIGTERM");
      await closed;
    });
    const display = await new Promise<string>((resolve, reject) => {
      xvfb.once("error", reject);
      xvfb.once("exit", () =>
        reject(new Error("Xvfb exited before publishing its display")),
      );
      let output = "";
      xvfb.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes("\n")) resolve(":" + output.trim());
      });
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1800);
    t.after(() => clearTimeout(timer));
    const result = await recordSession({
      dir,
      runId: "x11-test",
      worldId: "m1",
      display,
      agents: [{ agentId: "a", username: "alice" }],
      browser: {
        focus: async () => {},
        captureGame: async () => {
          throw new Error("must not capture canvas");
        },
      },
      deadline: Date.now() + 10000,
      signal: controller.signal,
      checkQuota: () => {},
    });
    assert.equal(result.status, "interrupted", result.error);
    assert.ok(result.frames > 0);
    const { stdout } = await exec("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_name",
      "-of",
      "json",
      join(result.directory, "session.mp4"),
    ]);
    assert.equal(JSON.parse(stdout).streams[0].codec_name, "h264");
  },
);

test("desktop capture rotates tabs without calling the game renderer", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-desktop-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Use a real encoder with a synthetic screen on hosts without X11.
  const wrapper = join(dir, "ffmpeg-test");
  await writeFile(
    wrapper,
    `#!${process.execPath}
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const start = args.indexOf('x11grab') - 1;
if (start < 0) process.exit(91);
const end = args.indexOf('-i', start) + 2;
args.splice(start, end - start, '-re', '-f', 'lavfi', '-i', 'color=c=blue:s=1280x900:r=10');
const child = spawn('ffmpeg', args, { stdio: 'inherit' });
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', code => process.exit(code ?? 1));
`,
    { mode: 0o700 },
  );
  const previous = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = wrapper;
  t.after(() => {
    if (previous === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = previous;
  });
  const focused: string[] = [];
  const result = await recordSession({
    dir,
    runId: "desktop-test",
    worldId: "m1",
    agents: [
      { agentId: "a", username: "alice" },
      { agentId: "b", username: "bob" },
    ],
    display: ":99",
    browser: {
      focus: async (id) => {
        focused.push(id);
      },
      captureGame: async () => {
        throw new Error("renderer must not be used");
      },
    },
    deadline: Date.now() + 2200,
    signal: new AbortController().signal,
    checkQuota: () => {},
    slotMs: 500,
  });
  assert.equal(result.status, "completed", result.error);
  assert.ok(result.frames > 0);
  const metadata = JSON.parse(
    await readFile(join(result.directory, "recording.json"), "utf8"),
  );
  assert.equal(metadata.firstFrameAt, null);
  assert.ok(metadata.captureStartedAt > 0);
  assert.ok(focused.includes("a") && focused.includes("b"));
  const timeline = (
    await readFile(join(result.directory, "timeline.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(timeline.some((e) => e.type === "switch" && e.agentId === "b"));
  const { stdout } = await exec("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_name:format=duration",
    "-of",
    "json",
    join(result.directory, "session.mp4"),
  ]);
  const media = JSON.parse(stdout);
  assert.equal(media.streams[0].codec_name, "h264");
  assert.ok(Number(media.format.duration) > 1);
});

test("capture failure returns a failed recording without aborting the experiment", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-video-failure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const controller = new AbortController();
  const result = await recordSession({
    dir,
    runId: "test",
    worldId: "m1",
    agents: [{ agentId: "a", username: "alice" }],
    browser: {
      focus: async () => {},
      captureGame: async () => {
        throw new Error("renderer unavailable");
      },
    },
    deadline: Date.now() + 1000,
    signal: controller.signal,
    checkQuota: () => {},
  });
  assert.equal(result.status, "failed");
  assert.match(result.error!, /renderer unavailable/);
  assert.equal(controller.signal.aborted, false);
  assert.equal(
    JSON.parse(await readFile(join(result.directory, "recording.json"), "utf8"))
      .status,
    "failed",
  );
});
for (const interrupt of [false, true])
  test(`rotating recording ${interrupt ? "interrupted" : "completed"}: playable MP4 with a trace-aligned timeline`, async (t) => {
    await verifyRecorder();
    const dir = await mkdtemp(join(tmpdir(), "swarm-video-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const { stdout: jpeg } = await exec(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=320x240",
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "pipe:1",
      ],
      { encoding: "buffer" },
    );
    const focused: string[] = [];
    const controller = new AbortController();
    let captures = 0;
    const result = await recordSession({
      dir,
      runId: "test-run",
      worldId: "m1",
      agents: [
        { agentId: "a", username: "alice" },
        { agentId: "b", username: "bob" },
      ],
      browser: {
        focus: async (id) => {
          focused.push(id);
        },
        captureGame: async () => {
          if (interrupt && ++captures === 10) controller.abort();
          return jpeg;
        },
      },
      deadline: Date.now() + 1600,
      signal: controller.signal,
      checkQuota: () => {},
      slotMs: 300,
    });
    assert.equal(result.status, interrupt ? "interrupted" : "completed");
    assert.ok(focused.includes("a") && focused.includes("b"));
    const events = (
      await readFile(join(result.directory, "timeline.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(events.some((e) => e.type === "switch" && e.agentId === "b"));
    assert.ok(
      events
        .filter((e) => e.type === "frame")
        .every((e) => e.capturedAt && e.videoSeconds >= 0),
    );
    const { stdout } = await exec("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_name,width,height:format=duration",
      "-of",
      "json",
      join(result.directory, "session.mp4"),
    ]);
    const media = JSON.parse(stdout);
    assert.equal(media.streams[0].codec_name, "h264");
    assert.equal(media.streams[0].width, 960);
    const captured = events.filter((e) => e.type === "frame");
    const observedDuration =
      (captured.at(-1).capturedAt - captured[0].capturedAt) / 1000;
    assert.ok(
      Math.abs(Number(media.format.duration) - observedDuration) < 0.5,
      "video time must track capture wall time",
    );
  });

test("recording refuses work when its artifact quota is exhausted", async () => {
  await assert.rejects(
    recordSession({
      dir: "/unused",
      runId: "test",
      worldId: "m1",
      agents: [{ agentId: "a", username: "alice" }],
      browser: {
        focus: async () => {
          throw new Error("must not focus");
        },
        captureGame: async () => Buffer.alloc(0),
      },
      deadline: Date.now() + 1000,
      signal: new AbortController().signal,
      checkQuota: () => {
        throw new Error("artifact quota exhausted");
      },
    }),
    /quota exhausted/,
  );
});
