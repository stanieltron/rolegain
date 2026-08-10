import type { IncomingMessage, ServerResponse } from "node:http";
import { assertPublicHttpUrl } from "../infrastructure/public-http.js";

const PUBLIC_HOST_CHECKS = new Map<string, Promise<boolean>>();

const BLOCKED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "content-security-policy",
  "content-security-policy-report-only",
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "transfer-encoding",
  "x-frame-options",
]);

const BLOCKED_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "origin",
  "referer",
]);

export function proxiedEmployerHost(hostHeader: string | undefined) {
  const match = (hostHeader || "").match(
    /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)\.localhost(?::\d+)?$/i,
  );
  if (!match) return undefined;
  const hostname = match[1].toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.includes("..") ||
    /^\d+(?:\.\d+){3}$/.test(hostname)
  )
    return undefined;
  return hostname;
}

export async function proxyEmployerRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    applicationFormAutofillScript: string;
    isAllowedHost: (hostname: string) => Promise<boolean>;
  },
) {
  const remoteHost = proxiedEmployerHost(request.headers.host);
  if (!remoteHost) return false;
  // The regular app is deliberately non-embeddable, while employer pages are
  // displayed inside RolegAIn's review iframe. Remove the app-level frame
  // denial before forwarding the separately allow-listed employer origin.
  response.removeHeader("X-Frame-Options");
  response.removeHeader("Content-Security-Policy");
  if (
    !(await publicEmployerHost(remoteHost)) ||
    !(await options.isAllowedHost(remoteHost))
  ) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Employer origin is not approved for this workspace.");
    return true;
  }

  const employerUrl = new URL(request.url || "/", `https://${remoteHost}`);
  const remoteFetchTarget =
    employerUrl.pathname === "/__job_apply_go_remote_fetch"
      ? employerUrl.searchParams.get("url")
      : undefined;
  const remoteUrl = remoteFetchTarget
    ? new URL(remoteFetchTarget)
    : employerUrl;
  if (
    remoteFetchTarget &&
    !/^ashbyhq-infra-prd-main-app-uploaded-files-[a-z0-9-]+\.s3(?:\.dualstack)?\.[a-z0-9-]+\.amazonaws\.com$/i.test(
      remoteUrl.hostname,
    )
  ) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Remote upload target is not approved.");
    return true;
  }
  if (remoteFetchTarget && !(await publicEmployerHost(remoteUrl.hostname))) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Remote upload target is not public.");
    return true;
  }
  const headers = new Headers();
  for (const [name, rawValue] of Object.entries(request.headers)) {
    if (BLOCKED_REQUEST_HEADERS.has(name) || rawValue === undefined) continue;
    headers.set(name, Array.isArray(rawValue) ? rawValue.join(", ") : rawValue);
  }
  if (request.headers.origin && !remoteFetchTarget)
    headers.set("origin", remoteUrl.origin);
  if (request.headers.referer)
    headers.set(
      "referer",
      remoteFetchTarget
        ? `https://${remoteHost}/`
        : rewriteProxyUrlToRemote(request.headers.referer, remoteHost),
    );

  const method = request.method || "GET";
  const body = /^(GET|HEAD)$/i.test(method)
    ? undefined
    : new Uint8Array(await readRequestBody(request));
  const upstream = await fetch(remoteUrl, {
    method,
    headers,
    body,
    redirect: "manual",
  });

  for (const [name, value] of upstream.headers.entries()) {
    if (BLOCKED_RESPONSE_HEADERS.has(name) || name === "set-cookie") continue;
    response.setHeader(name, value);
  }
  const getSetCookie = (upstream.headers as Headers & {
    getSetCookie?: () => string[];
  }).getSetCookie;
  const cookies = getSetCookie?.call(upstream.headers).map((cookie) =>
    cookie.replace(/;\s*Domain=[^;]+/gi, ""),
  );
  if (cookies?.length) response.setHeader("set-cookie", cookies);

  const location = upstream.headers.get("location");
  if (location)
    response.setHeader(
      "location",
      rewriteRemoteRedirect(location, remoteUrl, request.headers.host || ""),
    );

  const contentType = upstream.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    const html = await upstream.text();
    const bridge = `<script>window.__ROLEGAIN_ORIGINAL_URL__=${safeJson(remoteUrl.toString())};</script><script>${options.applicationFormAutofillScript}</script>`;
    const injected = /<\/body>/i.test(html)
      ? html.replace(/<\/body>/i, `${bridge}</body>`)
      : `${html}${bridge}`;
    response.setHeader("content-type", contentType);
    response.writeHead(upstream.status);
    response.end(injected);
    return true;
  }

  response.writeHead(upstream.status);
  response.end(Buffer.from(await upstream.arrayBuffer()));
  return true;
}

function publicEmployerHost(hostname: string) {
  let check = PUBLIC_HOST_CHECKS.get(hostname);
  if (!check) {
    check = assertPublicHttpUrl(new URL(`https://${hostname}/`))
      .then(() => true)
      .catch(() => false);
    PUBLIC_HOST_CHECKS.set(hostname, check);
  }
  return check;
}

function rewriteProxyUrlToRemote(value: string, remoteHost: string) {
  try {
    const url = new URL(value);
    if (url.hostname === `${remoteHost}.localhost`) {
      url.protocol = "https:";
      url.hostname = remoteHost;
      url.port = "";
    }
    return url.toString();
  } catch {
    return `https://${remoteHost}/`;
  }
}

function rewriteRemoteRedirect(
  location: string,
  currentRemoteUrl: URL,
  localHost: string,
) {
  const target = new URL(location, currentRemoteUrl);
  if (target.hostname !== currentRemoteUrl.hostname) return target.toString();
  const port = localHost.split(":")[1] || "4317";
  target.protocol = "http:";
  target.hostname = `${target.hostname}.localhost`;
  target.port = port;
  return target.toString();
}

function safeJson(value: string) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

async function readRequestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 25 * 1024 * 1024)
      throw new Error("Employer request body exceeds 25 MB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
