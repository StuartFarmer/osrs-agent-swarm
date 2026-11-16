import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { writeJson } from "./world.ts";

const exec = promisify(execFile);
const ffmpeg = () => process.env.FFMPEG_PATH || "ffmpeg";
export type RecordingResult = {
  directory: string;
  status: "completed" | "interrupted" | "failed";
  frames: number;
  error?: string;
};
type RecordingOptions = {
  dir: string;
  runId: string;
  worldId: string;
  agents: { agentId: string; username: string; displayName?: string }[];
  browser: {
    focus(id: string): Promise<void>;
    captureGame(id: string, label: string): Promise<Buffer>;
  };
  deadline: number;
  signal: AbortSignal;
  checkQuota(): void;
  slotMs?: number;
  display?: string;
};

export async function verifyRecorder(): Promise<void> {
  const [{ stdout: encoders }, { stdout: filters }] = await Promise.all([
    exec(ffmpeg(), ["-hide_banner", "-encoders"], { timeout: 10000 }),
    exec(ffmpeg(), ["-hide_banner", "-filters"], { timeout: 10000 }),
  ]);
  if (!encoders.includes("libx264") || !filters.includes("drawtext"))
    throw new Error("Recording requires FFmpeg with libx264 and drawtext");
}

async function bounded<T>(
  work: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function recordSession(
  o: RecordingOptions,
): Promise<RecordingResult> {
  o.checkQuota();
  o.signal.throwIfAborted();
  const slotMs = o.slotMs ?? 30000;
  if (
    !o.agents.length ||
    !Number.isFinite(o.deadline) ||
    o.deadline <= Date.now() ||
    !Number.isFinite(slotMs) ||
    slotMs < 1
  )
    throw new Error("recording requires agents and a future run deadline");
  const directory = join(o.dir, "recordings", "recording-" + randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const timeline = (data: unknown) =>
    appendFileSync(
      join(directory, "timeline.jsonl"),
      JSON.stringify(data) + "\n",
      { mode: 0o600 },
    );
  if (o.display) {
    await bounded(
      o.browser.focus(o.agents[0].agentId),
      5000,
      "Timed out focusing recording tab",
    );
    await writeFile(join(directory, "label.txt"), "", { mode: 0o600 });
  }
  const captureStartedAt = Date.now();
  const encoder = spawn(
    ffmpeg(),
    [
      "-hide_banner",
      "-loglevel",
      "error",
      ...(o.display
        ? [
            "-f",
            "x11grab",
            "-video_size",
            "1280x900",
            "-framerate",
            "10",
            "-draw_mouse",
            "0",
            "-i",
            o.display,
            "-progress",
            "pipe:1",
            "-stats_period",
            "0.5",
          ]
        : [
            "-nostdin",
            "-use_wallclock_as_timestamps",
            "1",
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "-framerate",
            "10",
            "-i",
            "pipe:0",
          ]),
      "-an",
      "-vf",
      "setpts=PTS-STARTPTS,fps=10,scale=960:672:force_original_aspect_ratio=decrease,pad=960:672:(ow-iw)/2:(oh-ih)/2,setsar=1,drawtext=text='%{pts\\:hms}':fontcolor=white:fontsize=18:x=w-tw-12:y=10" +
        (o.display
          ? ",drawtext=textfile=label.txt:reload=1:expansion=none:fontcolor=white:fontsize=16:box=1:boxcolor=black:x=10:y=h-th-10"
          : ""),
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-preset",
      "veryfast",
      "-b:v",
      "1000k",
      "-maxrate",
      "1200k",
      "-bufsize",
      "2400k",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "30",
      "-movflags",
      "+frag_keyframe+empty_moov+default_base_moof",
      "-n",
      "session.mp4",
    ],
    { cwd: directory, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "",
    processError: Error | undefined,
    exited = false;
  encoder.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-65536);
  });
  encoder.stdin.on("error", () => {});
  encoder.on("error", (error) => {
    processError = error;
  });
  const closed = new Promise<number | null>((resolve) =>
    encoder.once("close", (code) => {
      exited = true;
      resolve(code);
    }),
  );
  let firstFrameAt: number | null = null,
    frames = 0,
    selected = -1,
    nextQuotaCheck = 0;
  let failure: unknown,
    reachedDeadline = false;
  let progress = "";
  encoder.stdout.on("data", (chunk) => {
    progress += chunk.toString();
    const lines = progress.split("\n");
    progress = lines.pop()!;
    for (const line of lines) {
      if (line.startsWith("frame=")) frames = Number(line.slice(6));
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      encoder.once("spawn", resolve);
      encoder.once("error", reject);
    });
    console.error(
      `[record] Saving ${join(directory, "session.mp4")} (${o.display ? "desktop" : "canvas"}, ${slotMs / 1000} seconds per agent)`,
    );
    while (!o.signal.aborted && Date.now() < o.deadline) {
      if (exited) throw processError ?? new Error("FFmpeg stopped: " + stderr);
      const began = Date.now();
      if (began >= nextQuotaCheck) {
        o.checkQuota();
        nextQuotaCheck = began + 1000;
      }
      const rotationStartedAt = o.display ? captureStartedAt : firstFrameAt;
      const index =
        rotationStartedAt === null
          ? 0
          : Math.floor((began - rotationStartedAt) / slotMs) % o.agents.length;
      const agent = o.agents[index];
      if (index !== selected)
        await bounded(
          o.browser.focus(agent.agentId),
          5000,
          "Timed out focusing recording tab",
        );
      const label = `${agent.agentId} | ${agent.displayName ?? agent.username} | ${o.worldId}`;
      if (o.display) {
        if (index !== selected) {
          await writeFile(join(directory, "label.next"), label, {
            mode: 0o600,
          });
          await rename(
            join(directory, "label.next"),
            join(directory, "label.txt"),
          );
          const switchedAt = Date.now();
          timeline({
            type: "switch",
            runId: o.runId,
            worldId: o.worldId,
            agentId: agent.agentId,
            username: agent.username,
            capturedAt: switchedAt,
            videoSeconds: (switchedAt - captureStartedAt) / 1000,
          });
          console.error(`[record] ${agent.agentId} (${agent.username})`);
          selected = index;
        }
        await delay(100, undefined, { signal: o.signal }).catch((error) => {
          if (!o.signal.aborted) throw error;
        });
        continue;
      }
      const jpeg = await bounded(
        o.browser.captureGame(agent.agentId, label),
        5000,
        "Timed out capturing game canvas",
      );
      const capturedAt = Date.now();
      if (o.signal.aborted || capturedAt >= o.deadline) break;
      if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8)
        throw new Error("game capture did not return JPEG");
      firstFrameAt ??= capturedAt;
      const videoSeconds = (capturedAt - firstFrameAt) / 1000;
      if (index !== selected) {
        timeline({
          type: "switch",
          runId: o.runId,
          worldId: o.worldId,
          agentId: agent.agentId,
          username: agent.username,
          capturedAt,
          videoSeconds,
        });
        console.error(`[record] ${agent.agentId} (${agent.username})`);
        selected = index;
      }
      await bounded(
        new Promise<void>((resolve, reject) =>
          encoder.stdin.write(jpeg, (error) =>
            error ? reject(error) : resolve(),
          ),
        ),
        5000,
        "FFmpeg stopped accepting frames",
      );
      timeline({
        type: "frame",
        agentId: agent.agentId,
        capturedAt,
        videoSeconds,
      });
      frames++;
      await delay(Math.max(0, 100 - (Date.now() - began)), undefined, {
        signal: o.signal,
      }).catch((error) => {
        if (!o.signal.aborted) throw error;
      });
    }
    reachedDeadline = Date.now() >= o.deadline;
  } catch (error) {
    if (!o.signal.aborted) failure = error;
  } finally {
    encoder.stdin.end(o.display ? "q\n" : undefined);
    try {
      const code = await bounded(
        closed,
        10000,
        "FFmpeg did not finish recording",
      );
      if (code !== 0)
        failure ??= processError ?? new Error("FFmpeg failed: " + stderr);
    } catch (error) {
      encoder.kill("SIGKILL");
      await closed;
      failure ??= error;
    }
  }
  if (!frames && !o.signal.aborted)
    failure ??= new Error("Recording ended before its first frame");
  await writeFile(join(directory, "encoder.log"), stderr, { mode: 0o600 });
  const result: RecordingResult = {
    directory,
    frames,
    status: failure ? "failed" : reachedDeadline ? "completed" : "interrupted",
    ...(failure
      ? { error: failure instanceof Error ? failure.message : String(failure) }
      : {}),
  };
  await writeJson(join(directory, "recording.json"), {
    ...result,
    runId: o.runId,
    worldId: o.worldId,
    firstFrameAt,
    finishedAt: Date.now(),
    slotMs,
    fps: 10,
    source: o.display ? "desktop" : "canvas",
    ...(o.display
      ? {
          captureStartedAt,
          timing:
            "Switch times are wall-clock offsets from encoder launch, not exact frame timestamps.",
        }
      : {}),
  });
  return result;
}
