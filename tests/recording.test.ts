import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordSession, verifyRecorder } from "../src/recording.ts";

const exec = promisify(execFile);
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
