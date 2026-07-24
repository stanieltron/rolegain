import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";

export async function serveStatic(
  pathname: string,
  response: ServerResponse,
  root: string,
): Promise<void> {
  const relative =
    pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let filePath = path.resolve(root, relative);
  if (!filePath.startsWith(path.resolve(root))) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  let info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) {
    filePath = path.join(root, "index.html");
    info = await stat(filePath).catch(() => null);
  }
  if (!info?.isFile()) {
    response.writeHead(404).end("UI build not found. Run npm run build.");
    return;
  }
  response.writeHead(200, {
    "Content-Type": contentType(filePath),
    "Cache-Control": filePath.endsWith("index.html")
      ? "no-cache"
      : "public, max-age=31536000, immutable",
  });
  createReadStream(filePath).pipe(response);
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}
