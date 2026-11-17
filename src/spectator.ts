import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import type { WorldHandle } from "./world.ts";
import { localUrl } from "./config.ts";
import { readFileSync } from "node:fs";

const mapPage = readFileSync(new URL("./spectator-map.html", import.meta.url));

// Only spectator and public cache routes: never forward logins, gateway control or management.
export function spectatorPath(
  method: string | undefined,
  raw: string,
): string | null {
  if (method !== "GET") return null;
  let url: URL;
  try {
    url = new URL(raw, "http://localhost");
  } catch {
    return null;
  }
  if (url.search || url.hash) return null;
  if (
    [
      "/",
      "/mapview",
      "/mapview/",
      "/playerpositions",
      "/worldmap.jag",
      "/client/mapview.js",
      "/crc",
      "/ondemand.zip",
      "/api/version",
      "/worldfeed",
    ].includes(url.pathname)
  )
    return url.pathname;
  if (
    /^\/(title|config|interface|media|versionlist|textures|wordenc|sounds)\d*$/.test(
      url.pathname,
    )
  )
    return url.pathname;
  return null;
}

export function startSpectator(
  world: Pick<WorldHandle, "gameUrl">,
  port = 6080,
  hostname = "127.0.0.1",
): Promise<Server> {
  const origin = new URL(localUrl(world.gameUrl, ["http:"]));
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((req, res) => {
    const path = spectatorPath(req.method, req.url ?? "/");
    if (!path || path === "/worldfeed") {
      res.writeHead(404).end("Not found");
      return;
    }
    if (path === "/") {
      res.writeHead(302, { Location: "/mapview/" }).end();
      return;
    }
    if (path === "/mapview" || path === "/mapview/") {
      res
        .writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        })
        .end(mapPage);
      return;
    }
    const upstream = request(
      new URL(path, origin),
      { method: "GET" },
      (response) => {
        res.writeHead(response.statusCode ?? 502, {
          "Content-Type":
            response.headers["content-type"] ?? "application/octet-stream",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.on("error", () => res.destroy());
        response.pipe(res);
      },
    );
    upstream.setTimeout(30000, () =>
      upstream.destroy(new Error("Spectator upstream timeout")),
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end("World unavailable");
    });
    res.on("close", () => upstream.destroy());
    upstream.end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket, head) => {
    if (
      spectatorPath(req.method, req.url ?? "") !== "/worldfeed" ||
      req.headers.upgrade?.toLowerCase() !== "websocket"
    ) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const headers: IncomingHttpHeaders = {
      Connection: "Upgrade",
      Upgrade: "websocket",
    };
    for (const name of [
      "sec-websocket-key",
      "sec-websocket-version",
      "sec-websocket-protocol",
      "sec-websocket-extensions",
    ])
      if (req.headers[name]) headers[name] = req.headers[name];
    const url = new URL("/worldfeed", origin);
    if (process.env.WORLD_FEED_TOKEN)
      url.searchParams.set("token", process.env.WORLD_FEED_TOKEN);
    const upstream = request(url, { headers });
    upstream.setTimeout(10000, () =>
      upstream.destroy(new Error("Feed handshake timeout")),
    );
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    upstream.on("response", (response) => {
      response.resume();
      socket.end(
        `HTTP/1.1 ${response.statusCode ?? 502} Feed unavailable\r\nConnection: close\r\n\r\n`,
      );
    });
    upstream.on("upgrade", (response, remote, remainder) => {
      remote.setTimeout(0);
      const responseHeaders = response.rawHeaders.reduce(
        (lines, value, i, all) =>
          i % 2 ? lines : lines + `${value}: ${all[i + 1]}\r\n`,
        "",
      );
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n${responseHeaders}\r\n`,
      );
      if (remainder.length) socket.write(remainder);
      if (head.length) remote.write(head);
      remote.on("error", () => socket.destroy());
      remote.on("close", () => socket.destroy());
      socket.on("close", () => remote.destroy());
      remote.pipe(socket).pipe(remote);
    });
    upstream.end();
  });
  // Include upgraded WebSockets when stopping; Server.close alone leaves those alive.
  const close = server.close.bind(server);
  server.close = (callback) => {
    for (const socket of sockets) socket.destroy();
    return close(callback);
  };
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}
