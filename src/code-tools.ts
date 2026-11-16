import { readFile, readdir, realpath } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { GameClient } from "./game.ts";
import type { Store } from "./store.ts";
import type { Trace } from "./trace.ts";
import type { AgentKey } from "./types.ts";
import { json } from "./agent-definition.ts";

const root = fileURLToPath(new URL("../vendor/rs-sdk/", import.meta.url));
export function boundedText(text: string): string {
  if (Buffer.byteLength(text) <= 8192) return text;
  return (
    Buffer.from(text).subarray(0, 8000).toString("utf8") +
    "\n[Output truncated. Query a smaller result or read another page.]"
  );
}
export function boundedScriptResult(value: unknown): unknown {
  const text = JSON.stringify(value ?? null);
  if (Buffer.byteLength(text) <= 32768) return value;
  const result = value as { ok?: boolean; elapsedMs?: number; error?: unknown };
  return {
    ok: result?.ok === true,
    elapsedMs: result?.elapsedMs,
    truncated: true,
    result: null,
    world: null,
    logs: [],
    error: result?.error ? boundedText(JSON.stringify(result.error)) : null,
    outputPreview: boundedText(text),
  };
}
async function referencePath(path: string): Promise<string> {
  if (
    !/^(sdk|wiki|learnings)(\/|$)/.test(path) ||
    path.split(/[\\/]/).includes("..")
  )
    throw new Error("Use a path inside sdk/, wiki/, or learnings/");
  const absolute = await realpath(resolve(root, path));
  const rel = relative(await realpath(root), absolute);
  if (
    rel.startsWith(".." + sep) ||
    !/^(sdk|wiki|learnings)(\/|$)/.test(rel.replaceAll(sep, "/"))
  )
    throw new Error("Reference path escaped its root");
  return absolute;
}
export async function readReference(
  path: string,
  startLine: number,
  lines: number,
): Promise<string> {
  if (
    !/\.(md|ts)$/.test(path) ||
    !Number.isInteger(startLine) ||
    startLine < 1 ||
    !Number.isInteger(lines) ||
    lines < 1 ||
    lines > 200
  )
    throw new Error("Invalid reference page");
  const all = (await readFile(await referencePath(path), "utf8")).split("\n");
  return boundedText(
    `${path} (${all.length} lines)\n` +
      all
        .slice(startLine - 1, startLine - 1 + lines)
        .map((line, i) => `${startLine + i}: ${line}`)
        .join("\n"),
  );
}
export async function searchReference(
  query: string,
  directory: string,
): Promise<string> {
  if (!query.trim() || query.length > 200)
    throw new Error("Invalid search query");
  const dir = await referencePath(directory);
  const matches: string[] = [];
  for (const file of (await readdir(dir, { recursive: true })).sort()) {
    if (!/\.(md|ts)$/.test(file)) continue;
    const path = relative(root, resolve(dir, file));
    const lines = (await readFile(await referencePath(path), "utf8")).split(
      "\n",
    );
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(query.toLowerCase())) continue;
      matches.push(`${path}:${i + 1}: ${lines[i].slice(0, 300)}`);
      if (matches.length >= 20)
        return boundedText(
          matches.join("\n") +
            "\n[First 20 matches; narrow the query/directory for more.]",
        );
    }
  }
  return boundedText(matches.join("\n") || "No matches.");
}

export function createCodeTools(
  key: AgentKey,
  game: GameClient,
  store: Store,
  trace: Trace,
): AgentTool[] {
  const tool = (
    name: string,
    description: string,
    fields: Record<string, TSchema>,
    work: (args: any, signal: AbortSignal) => Promise<string>,
  ): AgentTool => {
    const parameters = Type.Object(fields, { additionalProperties: false });
    return {
      name,
      label: name,
      description,
      parameters,
      async execute(_id, args, signal) {
        if (!Value.Check(parameters, args))
          throw new Error("Invalid tool arguments");
        const abort = signal ?? new AbortController().signal;
        abort.throwIfAborted();
        return {
          content: [{ type: "text", text: await work(args, abort) }],
          details: {},
        };
      },
    };
  };
  return [
    tool(
      "execute_code",
      "Execute TypeScript for YOUR character with sdk, bot, Spells and console available. Start with one action/10 seconds, then extend verified routines. Return small results; world=brief includes a compact current observation, none omits it. A timeout can leave previously sent game actions in progress: inspect before retrying. No bot_name argument is needed.",
      {
        code: Type.String({ minLength: 1, maxLength: 16000 }),
        timeoutSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 60 })),
        world: Type.Optional(
          Type.Union([Type.Literal("brief"), Type.Literal("none")]),
        ),
      },
      async (args, signal) => {
        if (!game.executeCode) throw new Error("SDK executor not connected");
        trace.check();
        store.append(key, { type: "script_started", data: json(args) });
        await trace.flush(key);
        const result = boundedScriptResult(
          await game.executeCode(
            args.code,
            (args.timeoutSeconds ?? 10) * 1000,
            signal,
            args.world ?? "brief",
          ),
        );
        store.append(key, { type: "script_result", data: json(result) });
        await trace.flush(key);
        return boundedText(JSON.stringify(result));
      },
    ),
    tool(
      "read_reference",
      "Read a page of the local upstream sdk/, wiki/, or learnings/ files. Begin with sdk/API.md or wiki/skills/<skill>.md. SDK TypeScript source is also readable. Paths are relative to rs-sdk.",
      {
        path: Type.String({ minLength: 1, maxLength: 300 }),
        startLine: Type.Optional(Type.Integer({ minimum: 1 })),
        lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      },
      (a) => readReference(a.path, a.startLine ?? 1, a.lines ?? 80),
    ),
    tool(
      "search_reference",
      "Case-insensitive literal search over local SDK docs/source, wiki, or learnings. Returns paths and line numbers for read_reference. Use a narrow directory such as wiki/skills, wiki/shops, wiki/npcs, or sdk.",
      {
        query: Type.String({ minLength: 1, maxLength: 200 }),
        directory: Type.String({ minLength: 1, maxLength: 300 }),
      },
      (a) => searchReference(a.query, a.directory),
    ),
  ];
}
