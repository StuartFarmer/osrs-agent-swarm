import { DatabaseSync } from "node:sqlite";
import { object, identifier, number } from "./config.ts";
import type {
  AgentKey,
  Memory,
  MemoryRevision,
  JsonValue,
  ActionOutcome,
} from "./types.ts";
export type EventInput = {
  type: string;
  data: JsonValue;
  taskId?: string;
  requestId?: string;
  actionId?: string;
};
export type JournalEvent = EventInput &
  AgentKey & { seq: number; time: string };
const empty = (): Memory => ({
  plan: [],
  beliefs: [],
  relationships: {},
  nextAction: "",
});
function scope(key: AgentKey): string {
  Object.values(key).forEach(identifier);
  return JSON.stringify([key.runId, key.worldId, key.agentId]);
}
export function validateMemory(value: unknown): Memory {
  const m = object(
    value,
    ["plan", "beliefs", "relationships", "nextAction"],
    "memory",
  );
  if (
    !["plan", "beliefs"].every(
      (k) =>
        Array.isArray(m[k]) &&
        (m[k] as unknown[]).every((x) => typeof x === "string"),
    ) ||
    typeof m.nextAction !== "string" ||
    !m.relationships ||
    typeof m.relationships !== "object" ||
    Array.isArray(m.relationships) ||
    !Object.values(m.relationships).every((x) => typeof x === "string")
  )
    throw new Error("invalid memory");
  return m as Memory;
}
export class Store {
  readonly db: DatabaseSync;
  guard: (extraBytes: number) => void = () => {};
  sanitizeEvent: (event: EventInput) => EventInput = (event) => event;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS memory(scope TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_scope ON events(scope,seq);
      CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY,scope TEXT NOT NULL,intent TEXT NOT NULL,outcome TEXT);
      CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY,scope TEXT NOT NULL,reserved REAL NOT NULL,actual REAL); `);
  }
  private transaction<T>(bytes: number, work: () => T): T {
    return this.exclusive(() => {
      this.guard(bytes + 65536);
      const result = work();
      this.guard(0);
      return result;
    });
  }
  exclusive<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private event(key: AgentKey, event: EventInput): JournalEvent {
    const time = new Date().toISOString();
    const value = { ...this.sanitizeEvent(event), ...key, time };
    const r = this.db
      .prepare("INSERT INTO events(scope,value) VALUES(?,?)")
      .run(scope(key), JSON.stringify(value));
    return { ...value, seq: Number(r.lastInsertRowid) };
  }
  append(key: AgentKey, event: EventInput): JournalEvent {
    return this.transaction(Buffer.byteLength(JSON.stringify(event)), () =>
      this.event(key, event),
    );
  }
  readMemory(key: AgentKey): MemoryRevision {
    const r = this.db
      .prepare("SELECT revision,value FROM memory WHERE scope=?")
      .get(scope(key));
    return r
      ? { revision: Number(r.revision), value: JSON.parse(r.value as string) }
      : { revision: 0, value: empty() };
  }
  updateMemory(
    key: AgentKey,
    expectedRevision: number,
    value: Memory,
    actor: string,
  ): MemoryRevision {
    number(expectedRevision, 0, Number.MAX_SAFE_INTEGER, "revision");
    validateMemory(value);
    return this.transaction(
      Buffer.byteLength(JSON.stringify(value)) * 2,
      () => {
        const prev = this.readMemory(key);
        if (prev.revision !== expectedRevision)
          throw new Error("memory revision conflict");
        const revision = prev.revision + 1;
        this.db
          .prepare(
            "INSERT INTO memory VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,value=excluded.value",
          )
          .run(scope(key), revision, JSON.stringify(value));
        this.event(key, {
          type: "memory_updated",
          data: { revision, value, actor },
        });
        return { revision, value: structuredClone(value) };
      },
    );
  }
  events(key: AgentKey, afterSeq = 0, limit = 50): JournalEvent[] {
    number(afterSeq, 0, Number.MAX_SAFE_INTEGER, "afterSeq");
    number(limit, 1, 1000, "limit");
    return this.db
      .prepare(
        "SELECT seq,value FROM events WHERE scope=? AND seq>? ORDER BY seq LIMIT ?",
      )
      .all(scope(key), afterSeq, limit)
      .map((r) => ({ ...JSON.parse(r.value as string), seq: Number(r.seq) }));
  }
  beginAction(key: AgentKey, id: string, intent: JsonValue): void {
    identifier(id);
    this.transaction(Buffer.byteLength(JSON.stringify(intent)) * 2, () => {
      this.db
        .prepare("INSERT INTO actions(id,scope,intent) VALUES(?,?,?)")
        .run(id, scope(key), JSON.stringify(intent));
      this.event(key, { type: "action_intent", actionId: id, data: intent });
    });
  }
  endAction(key: AgentKey, id: string, outcome: ActionOutcome): void {
    this.transaction(Buffer.byteLength(JSON.stringify(outcome)) * 2, () => {
      const r = this.db
        .prepare("UPDATE actions SET outcome=? WHERE id=? AND scope=?")
        .run(JSON.stringify(outcome), id, scope(key));
      if (r.changes !== 1) throw new Error("unknown action");
      this.event(key, { type: "action_outcome", actionId: id, data: outcome });
    });
  }
  pendingActions(
    key: AgentKey,
  ): { actionId: string; intent: JsonValue; outcome: ActionOutcome | null }[] {
    return this.db
      .prepare(
        "SELECT * FROM actions WHERE scope=? AND (outcome IS NULL OR json_extract(outcome,'$.status') IN ('uncertain','dispatched'))",
      )
      .all(scope(key))
      .map((r) => ({
        actionId: r.id as string,
        intent: JSON.parse(r.intent as string),
        outcome: r.outcome ? JSON.parse(r.outcome as string) : null,
      }));
  }
  readAction(key: AgentKey, id: string) {
    const r = this.db
      .prepare("SELECT id,intent,outcome FROM actions WHERE scope=? AND id=?")
      .get(scope(key), id);
    return r
      ? {
          actionId: r.id as string,
          intent: JSON.parse(r.intent as string) as JsonValue,
          outcome: r.outcome
            ? (JSON.parse(r.outcome as string) as ActionOutcome)
            : null,
        }
      : null;
  }
  reserve(key: AgentKey, id: string, upperUsd: number, capUsd: number): void {
    identifier(id);
    number(upperUsd, 0, Number.MAX_VALUE, "reservation", false);
    number(capUsd, 0, Number.MAX_VALUE, "budget", false);
    this.transaction(1024, () => {
      if (this.spending() + upperUsd > capUsd)
        throw new Error("budget exhausted");
      this.db
        .prepare("INSERT INTO usage(id,scope,reserved) VALUES(?,?,?)")
        .run(id, scope(key), upperUsd);
      this.event(key, {
        type: "usage_reserved",
        requestId: id,
        data: { upperUsd },
      });
    });
  }
  settle(id: string, actualUsd: number | null): void {
    if (actualUsd === null) return;
    number(actualUsd, 0, Number.MAX_VALUE, "cost", false);
    this.transaction(1024, () => {
      const r = this.db
        .prepare("SELECT scope,actual FROM usage WHERE id=?")
        .get(id);
      if (!r) throw new Error("unknown reservation");
      if (r.actual !== null) return;
      this.db
        .prepare("UPDATE usage SET actual=? WHERE id=?")
        .run(actualUsd, id);
      const [runId, worldId, agentId] = JSON.parse(r.scope as string);
      this.event(
        { runId, worldId, agentId },
        { type: "usage_settled", requestId: id, data: { actualUsd } },
      );
    });
  }
  spending(): number {
    return Number(
      this.db
        .prepare(
          "SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) AS total FROM usage",
        )
        .get()!.total,
    );
  }
  close(): void {
    this.db.close();
  }
}
