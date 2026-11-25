import test from "node:test";
import assert from "node:assert/strict";
import {
  readReference,
  searchReference,
} from "../src/code-tools.ts";
import { runebench } from "../agents/runebench.ts";

test("baseline reads and searches pinned SDK documentation without opening private files", async () => {
  assert.match(await readReference("sdk/API.md", 1, 80), /chopTree/);
  assert.match(
    await searchReference("woodcutting", "wiki/skills"),
    /woodcutting/,
  );
  for (const path of [
    "../package.json",
    "bots/a/bot.env",
    "wiki/../../.env",
    "/etc/passwd",
  ])
    await assert.rejects(readReference(path, 1, 20));
  const page = await readReference("sdk/API.md", 1, 400);
  assert.ok(Buffer.byteLength(page) > 8192);
  assert.match(page, /400:/);

});

test("SDK baseline carries instructions and private notes, without injecting the raw tableau", async () => {
  const messages = await runebench.buildContext({
    view: {
      stamp: { sessionEpoch: "a", observationSeq: 1, observedAt: 1 },
      domains: [], observation: "# Overview",
      derived: {},
    },
    memory: {
      read: () => ({
        revision: 1,
        value: {
          plan: ["Try fishing"],
          beliefs: [],
          relationships: {},
          nextAction: "Read fishing guide",
        },
      }),
    },
    history: { search: () => [] },
    objective: "Earn coins",
    instructions: "Study shops",
    taskMessages: [{ role: "user", content: "Go", timestamp: 1 }],
  });
  const text = JSON.stringify(messages);
  assert.match(text, /Try fishing/);
  assert.match(text, /execute_code/);
  assert.doesNotMatch(text, /RAW_WORLD_SENTINEL|live-state/);
});
