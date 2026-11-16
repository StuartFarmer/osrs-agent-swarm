import { DatabaseSync } from "node:sqlite";

export function hasCollectedNames(path: string): boolean {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return !!db.prepare("SELECT 1 FROM names LIMIT 1").get();
  } finally {
    db.close();
  }
}

export function allocateNames(
  path: string,
  scope: string,
  agentIds: string[],
): { agentId: string; username: string; displayName: string }[] {
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout=10000;
      CREATE TABLE IF NOT EXISTS allocations(scope TEXT, agent_id TEXT, name_key TEXT UNIQUE NOT NULL,
        PRIMARY KEY(scope,agent_id)); BEGIN IMMEDIATE;`);
    const saved = db
      .prepare(
        `SELECT a.agent_id AS agentId,n.name_key AS username,n.display_name AS displayName
      FROM allocations a JOIN names n ON n.name_key=a.name_key WHERE a.scope=?`,
      )
      .all(scope) as {
      agentId: string;
      username: string;
      displayName: string;
    }[];
    if (saved.length) {
      if (
        saved.length !== agentIds.length ||
        agentIds.some((id) => !saved.some((n) => n.agentId === id))
      )
        throw new Error("name allocation roster mismatch");
      db.exec("COMMIT");
      return agentIds.map((id) => ({
        ...saved.find((n) => n.agentId === id)!,
      }));
    }
    const names = db
      .prepare(
        `SELECT name_key AS username,display_name AS displayName FROM names
      WHERE NOT EXISTS(SELECT 1 FROM allocations a WHERE a.name_key=names.name_key)
      ORDER BY random() LIMIT ?`,
      )
      .all(agentIds.length) as { username: string; displayName: string }[];
    if (names.length < agentIds.length)
      throw new Error(
        "name pool exhausted; collect more names before creating this roster",
      );
    for (const [index, name] of names.entries()) {
      if (
        !/^[a-z0-9][a-z0-9_]{0,11}$/.test(name.username) ||
        name.username.endsWith("_")
      )
        throw new Error("name pool contains an invalid game username");
      db.prepare("INSERT INTO allocations VALUES(?,?,?)").run(
        scope,
        agentIds[index],
        name.username,
      );
    }
    db.exec("COMMIT");
    return names.map((n, i) => ({ agentId: agentIds[i], ...n }));
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    db.close();
  }
}
