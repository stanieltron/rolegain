import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_JSON_BODY_SIZE = 22 * 1024 * 1024;

export async function readJson(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    size += value.length;
    if (size > MAX_JSON_BODY_SIZE)
      throw new Error("Request body is larger than 22 MB");
    chunks.push(value);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  if (response.headersSent) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

export function setCors(
  request: IncomingMessage,
  response: ServerResponse,
  configuredOrigin?: string,
): void {
  const origin = request.headers.origin;
  let allowedOrigin =
    configuredOrigin?.replace(/\/+$/, "") || "http://127.0.0.1:5173";
  if (origin) {
    try {
      const url = new URL(origin);
      if (
        (!configuredOrigin &&
          url.protocol === "http:" &&
          (url.hostname === "127.0.0.1" ||
            url.hostname === "localhost" ||
            url.hostname.endsWith(".localhost"))) ||
        origin.replace(/\/+$/, "") === allowedOrigin
      )
        allowedOrigin = origin;
    } catch {
      // Keep the development UI origin as the only fallback.
    }
  }
  response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type",
  );
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Private-Network", "true");
  response.setHeader("Vary", "Origin");
}
