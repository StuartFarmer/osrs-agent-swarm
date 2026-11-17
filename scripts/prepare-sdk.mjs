import { readFile, writeFile } from "node:fs/promises";

// Keep the pinned executor's cancellation/serialization; make its script timer optional.
const path = new URL("../vendor/rs-sdk/mcp/execute-code.ts", import.meta.url);
let source = await readFile(path, "utf8");
const replacements = [
  ["  timeoutMs: number,", "  timeoutMs: number | undefined,"],
  ["const timer = setTimeout(() => controller.abort(new ExecutionStopped('timeout', `Code execution timed out after ${timeoutMs / 60_000} minute(s)`)), timeoutMs);",
   "const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(new ExecutionStopped('timeout', `Code execution timed out after ${timeoutMs / 60_000} minute(s)`)), timeoutMs);"],
];
for (const [before, after] of replacements) {
  if (source.includes(after)) continue;
  if (source.split(before).length !== 2) throw new Error("Pinned SDK executor changed; optional-timeout patch refused");
  source = source.replace(before, after);
}
if (source !== await readFile(path, "utf8")) await writeFile(path, source);
