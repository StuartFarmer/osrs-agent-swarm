import { readFile, writeFile, unlink } from "node:fs/promises";
import { loadExperiment } from "./config.ts";
import type { AgentEntry } from "./types.ts";

export type Group = { archetype: string; count: number };

const archetypeName = /^[a-z][a-z0-9-]{0,31}$/;

// Turns archetype counts into concrete agent entries. Every entry uses the
// shared "general" definition; only the profile and instructions differ.
export function agentsFromGroups(
  groups: Group[],
  maxAgents: number,
): AgentEntry[] {
  if (!Array.isArray(groups) || groups.length < 1)
    throw new Error("groups must be a non-empty array");
  const counts = new Map<string, number>();
  for (const g of groups) {
    if (!g || typeof g !== "object")
      throw new Error("each group must be an object");
    if (typeof g.archetype !== "string" || !archetypeName.test(g.archetype))
      throw new Error("invalid archetype name");
    if (!Number.isInteger(g.count) || g.count < 0 || g.count > maxAgents)
      throw new Error("group count must be an integer from 0 to maxAgents");
    counts.set(g.archetype, (counts.get(g.archetype) ?? 0) + g.count);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total < 1 || total > maxAgents)
    throw new Error(`total agents must be between 1 and ${maxAgents}`);
  const agents: AgentEntry[] = [];
  for (const [archetype, count] of counts) {
    const base = `agents/archetypes/${archetype}`;
    for (let n = 1; n <= count; n++) {
      agents.push({
        id: `${archetype}-${String(n).padStart(2, "0")}`,
        definition: "general",
        profilePath: `${base}/profile.json`,
        instructionsPath: `${base}/instructions.md`,
      });
    }
  }
  return agents;
}

// Writes a complete experiment from a template (everything except agents) and
// a groups file, then validates the result with the normal loader. An invalid
// result is removed so no half-formed experiment is left behind.
export async function expandExperiment(opts: {
  template: string;
  groups: string;
  out: string;
  root?: string;
}): Promise<{ out: string; agents: number }> {
  const template = JSON.parse(await readFile(opts.template, "utf8"));
  const { groups } = JSON.parse(await readFile(opts.groups, "utf8"));
  if (!template || typeof template !== "object" || Array.isArray(template))
    throw new Error("template must be an object");
  const agents = agentsFromGroups(groups, template.maxAgents);
  const experiment = { ...template, agents };
  await writeFile(opts.out, JSON.stringify(experiment, null, 2) + "\n");
  try {
    await loadExperiment(opts.out, opts.root);
  } catch (error) {
    await unlink(opts.out);
    throw error;
  }
  return { out: opts.out, agents: agents.length };
}
