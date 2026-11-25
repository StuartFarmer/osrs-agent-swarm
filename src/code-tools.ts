import { randomUUID } from "node:crypto";
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
    lines < 1
  )
    throw new Error("Invalid reference page");
  const all = (await readFile(await referencePath(path), "utf8")).split("\n");
  return (
    `${path} (${all.length} lines)\n` +
      all
        .slice(startLine - 1, startLine - 1 + lines)
        .map((line, i) => `${startLine + i}: ${line}`)
        .join("\n")
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
      matches.push(`${path}:${i + 1}: ${lines[i]}`);
    }
  }
  return matches.join("\n") || "No matches.";
}

export function createCodeTools(
  key: AgentKey,
  game: GameClient,
  store: Store,
  trace: Trace,
  permadeath = false,
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
      "Execute inline code or a named private skill for YOUR character with sdk, bot, Spells and console. Pass input to a saved skill. There is no default script timeout; timeoutSeconds optionally sets one. world=brief or full includes an observation, none omits it. Cancellation or timeout can leave previously sent game actions in progress: inspect before retrying.",
      {
        code: Type.Optional(Type.String({ minLength: 1 })),
        skill: Type.Optional(Type.String({ minLength: 1 })),
        input: Type.Optional(Type.Unknown()),
        timeoutSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
        world: Type.Optional(
          Type.Union([
            Type.Literal("brief"),
            Type.Literal("full"),
            Type.Literal("none"),
          ]),
        ),
      },
      async (args, signal) => {
        if (!game.executeCode) throw new Error("SDK executor not connected");
        if (!!args.code === !!args.skill || (args.code && "input" in args))
          throw new Error("Provide either code, or skill with optional input");
        const skill = args.skill ? store.savedSkills(key, args.skill)[0] : undefined;
        if (args.skill && !skill) throw new Error("Unknown private skill");
        const code = skill ? "const input = JSON.parse(" + JSON.stringify(JSON.stringify(args.input ?? null)) + ");\n" + skill.code : args.code;
        trace.check();
        const actionId = randomUUID();
        store.append(key, { type: "script_started", actionId, data: json(skill ? { ...args, revision: skill.revision } : args) });
        await trace.flush(key);
        try {
          const result = await game.executeCode(
            code,
            args.timeoutSeconds === undefined ? undefined : args.timeoutSeconds * 1000,
            signal,
            args.world ?? "brief",
          );
          store.append(key, { type: "script_result", actionId, data: json(result) });
          await trace.flush(key);
          if (result && typeof result === "object" && "world" in result && typeof result.world === "string") {
            const { world, ...execution } = result;
            return JSON.stringify(execution) + "\n" + world;
          }
          return JSON.stringify(result);
        } catch (error) {
          store.append(key, {
            type: "script_failed",
            actionId,
            data: {
              uncertain: true,
              message: error instanceof Error ? error.message : String(error),
            },
          });
          await trace.flush(key);
          throw error;
        }
      },
    ),
    tool(
      "read_reference",
      "Read a page of the local upstream sdk/, wiki/, or learnings/ files. Begin with sdk/API.md or wiki/skills/<skill>.md. SDK TypeScript source is also readable. Paths are relative to rs-sdk.",
      {
        path: Type.String({ minLength: 1, maxLength: 300 }),
        startLine: Type.Optional(Type.Integer({ minimum: 1 })),
        lines: Type.Optional(Type.Integer({ minimum: 1 })),
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
    ...(permadeath ? [tool("save_lesson", "Save a general gameplay lesson that descendants can inherit. Include when it applies. Keep private relationships and unfinished plans in update_memory.", { lesson: Type.String({ minLength: 1 }) },
      async ({ lesson }) => {
        const event = store.append(key, { type: "lesson_saved", data: { lesson } });
        await trace.flush(key);
        return JSON.stringify({ revision: event.seq });
      })] : []),
    tool("save_skill", "Save or revise a reusable private TypeScript routine. Describe its prerequisites, expected effect and evidence. It runs with sdk, bot and JSON input.",
      { name: Type.String({ minLength: 1 }), description: Type.String({ minLength: 1 }), code: Type.String({ minLength: 1 }) },
      async (args) => {
        const event = store.append(key, { type: "skill_saved", data: json(args) });
        await trace.flush(key);
        return JSON.stringify({ name: args.name, revision: event.seq });
      }),
    tool("read_skills", "List your private skill descriptions, or read one named routine with its current code.",
      { name: Type.Optional(Type.String({ minLength: 1 })) },
      async (args) => JSON.stringify(store.savedSkills(key, args.name))),
  ];
}
