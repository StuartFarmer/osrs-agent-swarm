import test from "node:test";
import assert from "node:assert/strict";
import {
  readReference,
  searchReference,
  boundedText,
  boundedScriptResult,
} from "../src/code-tools.ts";
import { runebench, fitConversation } from "../agents/runebench.ts";
import { validateMessages } from "../src/runtime.ts";

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
  assert.ok(Buffer.byteLength(boundedText("🦀".repeat(10000))) <= 8192);
  const large: any = boundedScriptResult({
    ok: true,
    result: "x".repeat(1000000),
    error: null,
    world: null,
  });
  assert.equal(large.truncated, true);
  assert.equal(large.ok, true);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) < 32768);
});

test("SDK baseline carries instructions and private notes, without injecting the raw tableau", async () => {
  const messages = await runebench.buildContext({
    view: {
      stamp: { sessionEpoch: "a", observationSeq: 1, observedAt: 1 },
      domains: { nearby: "RAW_WORLD_SENTINEL" },
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

test("conversation bounds remove complete oldest exchanges, keeping the newest tool result paired", () => {
  const messages: any[] = [
    { role: "user", content: "instructions", timestamp: 1 },
    { role: "user", content: "task", timestamp: 1 },
  ];
  for (const id of ["old", "new"]) {
    messages.push({
      role: "assistant",
      content: [{ type: "toolCall", id, name: "execute_code", arguments: {} }],
      timestamp: 1,
    });
    messages.push({
      role: "toolResult",
      toolCallId: id,
      toolName: "execute_code",
      content: [{ type: "text", text: id + "x".repeat(1800) }],
      timestamp: 1,
    });
  }
  const context: any = { systemPrompt: "rules", messages, tools: [] };
  fitConversation(context, 3000);
  validateMessages(context.messages);
  assert.ok(Buffer.byteLength(JSON.stringify(context)) <= 3000);
  assert.equal(context.messages[2].content[0].id, "new");
  assert.throws(() => fitConversation(context, 100), /context byte limit/);
});
