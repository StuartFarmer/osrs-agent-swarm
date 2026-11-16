import {
  mkdirSync,
  readdirSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  openSync,
  fsyncSync,
  closeSync,
  linkSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { resolve, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { identifier } from "./config.ts";
import type { Store } from "./store.ts";
import type { AgentKey } from "./types.ts";
function diskBytes(path: string): number {
  if (!existsSync(path)) return 0;
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new Error("artifact symlink forbidden");
  return st.isDirectory()
    ? readdirSync(path).reduce((n, x) => n + diskBytes(join(path, x)), 0)
    : st.size;
}
export function redact(
  value: unknown,
  secrets: readonly string[] = [],
): unknown {
  if (typeof value === "string")
    return secrets
      .filter(Boolean)
      .reduce((v, s) => v.split(s).join("[REDACTED]"), value);
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /^(api.?key|authorization|password|token|secret|cookie)$/i.test(k)
          ? "[REDACTED]"
          : redact(v, secrets),
      ]),
    );
  return value;
}
export class Trace {
  readonly runDir: string;
  readonly store: Store;
  readonly maxBytes: number;
  readonly secrets: readonly string[];
  constructor(
    runDir: string,
    store: Store,
    maxBytes: number,
    secrets: readonly string[] = [],
  ) {
    this.runDir = resolve(runDir);
    this.store = store;
    this.maxBytes = maxBytes;
    this.secrets = secrets;
    mkdirSync(this.runDir, { recursive: true, mode: 0o700 });
    store.guard = (extra) => this.check(extra);
  }
  check(extra = 0): void {
    if (
      !Number.isFinite(extra) ||
      extra < 0 ||
      diskBytes(this.runDir) + extra > this.maxBytes
    )
      throw new Error("artifact quota exhausted");
  }
  private dir(key: AgentKey): string {
    Object.values(key).forEach(identifier);
    this.check();
    const dir = join(this.runDir, "agents", key.worldId, key.agentId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.check();
    return dir;
  }
  private durable(
    path: string,
    data: string | Buffer,
    flag: "w" | "a" = "w",
  ): void {
    const fd = openSync(path, flag, 0o600);
    try {
      if (flag === "a") appendFileSync(fd, data);
      else writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  async flush(key: AgentKey): Promise<void> {
    const path = join(this.dir(key), "events.jsonl");
    let last = 0;
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8");
      const lines = text.split("\n");
      // A crash can leave one unterminated line; only that suffix is recoverable.
      if (lines.at(-1) !== "")
        this.durable(
          path,
          lines.slice(0, -1).join("\n") + (lines.length > 1 ? "\n" : ""),
        );
      for (const line of lines.slice(0, -1)) {
        try {
          const e = JSON.parse(line);
          if (!Number.isInteger(e.seq) || e.seq <= last) throw new Error();
          last = e.seq;
        } catch {
          throw new Error("corrupt event export");
        }
      }
    }
    for (;;) {
      const events = this.store.events(key, last, 1000);
      if (!events.length) return;
      const text =
        events.map((e) => JSON.stringify(redact(e, this.secrets))).join("\n") +
        "\n";
      this.check(Buffer.byteLength(text));
      this.durable(path, text, "a");
      last = events.at(-1)!.seq;
    }
  }
  private async artifact(
    key: AgentKey,
    id: string,
    extension: string,
    data: string | Buffer,
  ): Promise<string> {
    identifier(id);
    const path = join(this.dir(key), id + extension);
    if (existsSync(path)) throw new Error("artifact already exists");
    this.check(Buffer.byteLength(data));
    const temp = path + "." + randomUUID() + ".tmp";
    this.durable(temp, data);
    try {
      linkSync(temp, path);
    } finally {
      unlinkSync(temp);
    }
    return relative(this.runDir, path);
  }
  context(key: AgentKey, id: string, payload: unknown): Promise<string> {
    return this.artifact(
      key,
      id,
      ".json",
      JSON.stringify(redact(payload, this.secrets), null, 2),
    );
  }
  capture(key: AgentKey, id: string, png: Buffer): Promise<string> {
    if (
      !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      return Promise.reject(new Error("invalid PNG"));
    return this.artifact(key, id, ".png", png);
  }
}
