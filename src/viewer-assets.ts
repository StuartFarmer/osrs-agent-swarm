import { realpath, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute, extname } from "node:path";

export async function viewerAsset(root: string, pathname: string) {
  const name =
    decodeURIComponent(pathname.slice("/viewer/".length)) || "index.html";
  if (name.includes("\0") || name.includes("\\")) return undefined;
  try {
    const base = await realpath(root);
    const path = await realpath(resolve(base, name));
    const rel = relative(base, path);
    if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel))
      return undefined;
    const info = await stat(path);
    if (!info.isFile()) return undefined;
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".wasm": "application/wasm",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".txt": "text/plain; charset=utf-8",
    };
    return {
      path,
      size: info.size,
      type: types[extname(path)] ?? "application/octet-stream",
    };
  } catch (error) {
    if (
      ["ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      return undefined;
    throw error;
  }
}
