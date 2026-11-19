import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { identifier } from "./config.ts";

export async function scoreboard(worldDir: string, after: number) {
  if (!Number.isSafeInteger(after) || after < 0)
    throw new Error("Invalid scoreboard cursor");
  let runId: string;
  try {
    runId = identifier(
      JSON.parse(
        await readFile(resolve(worldDir, "scoreboard-run.json"), "utf8"),
      ).runId,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { runId: null, rows: [] };
    throw err;
  }
  const db = new DatabaseSync(
    resolve(worldDir, "../../../runs", runId, "state.sqlite"),
    { readOnly: true },
  );
  try {
    const rows = db
      .prepare(
        `SELECT seq, json_extract(value,'$.time') AS time,
      json_extract(value,'$.agentId') AS id, coalesce(json_extract(value,'$.data.displayName'),json_extract(value,'$.data.username')) AS name,
      json_extract(value,'$.data.tick') AS tick, json_extract(value,'$.data.phase') AS phase,
      json_extract(value,'$.data.frame') AS frame, json_extract(value,'$.data.retired') AS dead,
      json_extract(value,'$.data.position.wealth') AS wealth, json_extract(value,'$.data.position.cash') AS cash
      FROM events WHERE json_extract(value,'$.type')='local_ge_wealth' AND seq>? ORDER BY seq LIMIT 2000`,
      )
      .all(after);
    // Older run journals predate the provider balance table.
    const hasBilling = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='openrouter_balance'").get();
    const billing = hasBilling && db.prepare("SELECT value FROM openrouter_balance WHERE singleton=1").get();
    return { runId, rows, ...(billing && { billing: JSON.parse(String(billing.value)) }) };
  } finally {
    db.close();
  }
}
