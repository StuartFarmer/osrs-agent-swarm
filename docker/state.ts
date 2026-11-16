import { cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { identifier } from "../src/config.ts";
import { readWorld, worldPath, SDK_REVISION } from "../src/world.ts";

export async function seedContainerWorld(
  template: string,
  id: string,
  root = process.cwd(),
): Promise<void> {
  const dir = worldPath(id, root);
  if (existsSync(dir)) {
    await readWorld(id, root);
    return;
  }
  const metadata = JSON.parse(
    await readFile(join(template, "world.json"), "utf8"),
  );
  if (
    metadata.id !== id ||
    metadata.dir !== dir ||
    metadata.gameDir !== join(dir, "game") ||
    metadata.revision !== SDK_REVISION
  )
    throw new Error(
      "Container world template does not match this experiment/path",
    );
  await mkdir(dirname(dir), { recursive: true });
  const staging = dir + "-seeding-" + randomUUID();
  try {
    await cp(template, staging, {
      recursive: true,
      preserveTimestamps: true,
      errorOnExist: true,
      force: false,
    });
    await rename(staging, dir);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  await readWorld(id, root);
}
export async function containerRunId(
  path: string,
): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return identifier(JSON.parse(text).runId);
}
