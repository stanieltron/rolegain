import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { assertPublicHttpUrl } from "../infrastructure/public-http.js";
import {
  EMPLOYER_PROXY_PATH,
  employerProxyBase,
  type EmployerProxySession,
  verifyEmployerProxySession,
} from "./employer-proxy-session.js";

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
  "cookie",
  "host",
  "origin",
  "referer",
]);

interface EmployerProxyFile {
  file: string;
  name: string;
  mimeType: string;
  size: number;
}

interface EmployerProxyAutofill {
  applicationId?: string;
  cv?: { name: string; url: string };
  [key: string]: unknown;
}

interface SignedProxyRequest {
  token: string;
  session: EmployerProxySession;
  basePath: string;
  remotePath: string;
  search: string;
}

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
    sessionSecret?: string;
    getAutofill?: (
      session: EmployerProxySession,
    ) => Promise<EmployerProxyAutofill | null>;
    getCv?: (
      session: EmployerProxySession,
    ) => Promise<EmployerProxyFile | undefined>;
  },
) {
  const signed = options.sessionSecret
    ? signedProxyRequest(request, options.sessionSecret)
    : undefined;
  const signedPath = (request.url || "").startsWith(
    `${EMPLOYER_PROXY_PATH}/`,
  );
  if (signedPath && !signed) {
    response.removeHeader("X-Frame-Options");
    response.removeHeader("Content-Security-Policy");
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Employer proxy session is invalid or expired.");
    return true;
  }
  const localRemoteHost = proxiedEmployerHost(request.headers.host);
  if (!signed && !localRemoteHost) return false;
  const sessionTarget = signed ? new URL(signed.session.targetUrl) : undefined;
  const remoteHost = sessionTarget?.hostname || localRemoteHost!;
  // The regular app is deliberately non-embeddable, while employer pages are
  // displayed inside RolegAIn's review iframe. Remove the app-level frame
  // denial before forwarding the separately allow-listed employer origin.
  response.removeHeader("X-Frame-Options");
  response.removeHeader("Content-Security-Policy");
  if (
    !(await publicEmployerHost(remoteHost)) ||
    (!signed && !(await options.isAllowedHost(remoteHost)))
  ) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Employer origin is not approved for this workspace.");
    return true;
  }

  if (signed?.remotePath === "/__rolegain/autofill") {
    const payload = await options.getAutofill?.(signed.session);
    const body = payload
      ? {
          ...payload,
          ...(payload.cv
            ? {
                cv: {
                  ...payload.cv,
                  url: `${signed.basePath}/__rolegain/cv`,
                },
              }
            : {}),
        }
      : null;
    response.writeHead(payload ? 200 : 404, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
    });
    response.end(JSON.stringify(body));
    return true;
  }
  if (signed?.remotePath === "/__rolegain/cv") {
    const cv = await options.getCv?.(signed.session);
    if (!cv) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Application CV is unavailable.");
      return true;
    }
    response.writeHead(200, {
      "Content-Type": cv.mimeType,
      "Content-Length": cv.size,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(cv.name)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(cv.file).pipe(response);
    return true;
  }

  const employerUrl = signed
    ? new URL(`${signed.remotePath}${signed.search}`, sessionTarget!.origin)
    : new URL(request.url || "/", `https://${remoteHost}`);
  const remoteFetchTarget =
    employerUrl.pathname === "/__job_apply_go_remote_fetch" ||
    signed?.remotePath === "/__rolegain/remote-fetch"
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
  if (signed) {
    const cookies = signedEmployerCookies(
      request.headers.cookie,
      cookiePrefix(signed.token),
    );
    if (cookies) headers.set("cookie", cookies);
  } else if (request.headers.cookie) headers.set("cookie", request.headers.cookie);
  if (request.headers.origin && !remoteFetchTarget)
    headers.set("origin", remoteUrl.origin);
  if (request.headers.referer)
    headers.set(
      "referer",
      signed
        ? remoteUrl.toString()
        : remoteFetchTarget
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
    signed
      ? rewriteSignedEmployerCookie(
          cookie,
          cookiePrefix(signed.token),
          signed.basePath,
        )
      : cookie.replace(/;\s*Domain=[^;]+/gi, ""),
  );
  if (cookies?.length) response.setHeader("set-cookie", cookies);

  const location = upstream.headers.get("location");
  if (location)
    response.setHeader(
      "location",
      rewriteRemoteRedirect(
        location,
        remoteUrl,
        request.headers.host || "",
        signed?.basePath,
      ),
    );

  const contentType = upstream.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    const html = await upstream.text();
    const rewritten = signed
      ? rewriteEmployerHtml(html, remoteUrl, signed.basePath)
      : html;
    const runtime = signed
      ? `<script>${employerPathProxyRuntime(
          signed.basePath,
          remoteUrl,
          signed.session.targetUrl,
        )}</script>`
      : "";
    const withRuntime = runtime
      ? /<head(?:\s[^>]*)?>/i.test(rewritten)
        ? rewritten.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${runtime}`)
        : `${runtime}${rewritten}`
      : rewritten;
    const bridge = `<script>window.__ROLEGAIN_ORIGINAL_URL__=${safeJson(
      signed?.session.targetUrl || remoteUrl.toString(),
    )};window.__ROLEGAIN_PROXY_BASE__=${safeJson(
      signed?.basePath || "",
    )};</script><script>${options.applicationFormAutofillScript}</script>`;
    const injected = /<\/body>/i.test(withRuntime)
      ? withRuntime.replace(/<\/body>/i, `${bridge}</body>`)
      : `${withRuntime}${bridge}`;
    response.setHeader("content-type", contentType);
    response.setHeader("cache-control", "private, no-store");
    response.setHeader("referrer-policy", "no-referrer");
    response.writeHead(upstream.status);
    response.end(injected);
    return true;
  }

  if (signed && contentType.includes("text/css")) {
    const css = rewriteEmployerCss(
      await upstream.text(),
      remoteUrl,
      signed.basePath,
    );
    response.setHeader("content-type", contentType);
    response.setHeader("cache-control", "private, no-store");
    response.writeHead(upstream.status);
    response.end(css);
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
  signedBasePath?: string,
) {
  const target = new URL(location, currentRemoteUrl);
  if (target.hostname !== currentRemoteUrl.hostname) return target.toString();
  if (signedBasePath)
    return `${signedBasePath}${target.pathname}${target.search}${target.hash}`;
  const port = localHost.split(":")[1] || "4317";
  target.protocol = "http:";
  target.hostname = `${target.hostname}.localhost`;
  target.port = port;
  return target.toString();
}

function signedProxyRequest(
  request: IncomingMessage,
  secret: string,
): SignedProxyRequest | undefined {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const match = url.pathname.match(
    new RegExp(`^${EMPLOYER_PROXY_PATH}/([^/]+)(/.*)?$`),
  );
  if (!match) return undefined;
  const token = match[1];
  const session = verifyEmployerProxySession(token, secret);
  if (!session) return undefined;
  return {
    token,
    session,
    basePath: employerProxyBase(token),
    remotePath: match[2] || "/",
    search: url.search,
  };
}

export function rewriteEmployerHtml(
  html: string,
  remoteUrl: URL,
  proxyBasePath: string,
) {
  const attributes = html.replace(
    /\b(src|href|action|poster|data)=(['"])([^'"]*)\2/gi,
    (_full, attribute: string, quote: string, value: string) => {
      const rewritten = rewriteEmployerResourceUrl(
        value,
        remoteUrl,
        proxyBasePath,
      );
      return `${attribute}=${quote}${rewritten}${quote}`;
    },
  );
  return rewriteEmployerCss(attributes, remoteUrl, proxyBasePath);
}

function rewriteEmployerCss(
  css: string,
  remoteUrl: URL,
  proxyBasePath: string,
) {
  return css.replace(
    /url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi,
    (full, quote: string, value: string) => {
      const rewritten = rewriteEmployerResourceUrl(
        value,
        remoteUrl,
        proxyBasePath,
      );
      return rewritten === value
        ? full
        : `url(${quote}${rewritten}${quote})`;
    },
  );
}

function rewriteEmployerResourceUrl(
  value: string,
  remoteUrl: URL,
  proxyBasePath: string,
) {
  if (
    !value ||
    value.startsWith("#") ||
    /^(?:data|blob|javascript|mailto|tel):/i.test(value)
  )
    return value;
  try {
    const target = new URL(value, remoteUrl);
    return target.origin === remoteUrl.origin
      ? `${proxyBasePath}${target.pathname}${target.search}${target.hash}`
      : value;
  } catch {
    return value;
  }
}

function employerPathProxyRuntime(
  proxyBasePath: string,
  remoteUrl: URL,
  originalUrl: string,
) {
  const values = safeJson({
    proxyBasePath,
    remoteOrigin: remoteUrl.origin,
    remoteUrl: remoteUrl.toString(),
    originalUrl,
  });
  return `(() => {
    const config = ${values};
    window.__ROLEGAIN_PROXY_BASE__ = config.proxyBasePath;
    window.__ROLEGAIN_ORIGINAL_URL__ = config.originalUrl;
    const proxyUrl = (value) => {
      try {
        const target = new URL(value, config.remoteUrl);
        if (target.origin === location.origin && target.pathname.startsWith(config.proxyBasePath))
          return target.href;
        if (target.origin === config.remoteOrigin || target.origin === location.origin)
          return location.origin + config.proxyBasePath + target.pathname + target.search + target.hash;
      } catch {}
      return value;
    };
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const value = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
      const rewritten = proxyUrl(value);
      return input instanceof Request
        ? nativeFetch(new Request(rewritten, input), init)
        : nativeFetch(rewritten, init);
    };
    const nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      return nativeOpen.call(this, method, proxyUrl(String(url)), ...rest);
    };
    for (const method of ["pushState", "replaceState"]) {
      const native = history[method].bind(history);
      history[method] = (state, unused, url) => native(state, unused, url == null ? url : proxyUrl(String(url)));
    }
    let appData;
    Object.defineProperty(window, "__appData", {
      configurable: true,
      get: () => appData,
      set: (value) => {
        if (value && typeof value === "object" && typeof value.routerPrefix === "string")
          value.routerPrefix = config.proxyBasePath + "/";
        appData = value;
      },
    });
    const rewriteElement = (element) => {
      if (!(element instanceof Element)) return;
      for (const attribute of ["src", "href", "action", "poster", "data"]) {
        if (!element.hasAttribute(attribute)) continue;
        const value = element.getAttribute(attribute);
        const rewritten = proxyUrl(value || "");
        if (rewritten !== value) element.setAttribute(attribute, rewritten);
      }
    };
    new MutationObserver((records) => {
      for (const record of records) {
        rewriteElement(record.target);
        for (const node of record.addedNodes) {
          rewriteElement(node);
          if (node instanceof Element)
            node.querySelectorAll("[src],[href],[action],[poster],[data]").forEach(rewriteElement);
        }
      }
    }).observe(document, {subtree: true, childList: true, attributes: true, attributeFilter: ["src", "href", "action", "poster", "data"]});
  })();`;
}

function cookiePrefix(token: string) {
  return `__rg_${(token.split(".")[1] || token).slice(0, 12)}_`;
}

function signedEmployerCookies(
  header: string | undefined,
  prefix: string,
) {
  if (!header) return "";
  return header
    .split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie.startsWith(prefix))
    .map((cookie) => cookie.slice(prefix.length))
    .join("; ");
}

function rewriteSignedEmployerCookie(
  cookie: string,
  prefix: string,
  basePath: string,
) {
  const parts = cookie.split(";");
  parts[0] = `${prefix}${parts[0].trim()}`;
  const attributes = parts
    .slice(1)
    .map((part) => part.trim())
    .filter((part) => !/^domain=/i.test(part) && !/^path=/i.test(part));
  return [parts[0], ...attributes, `Path=${basePath}`].join("; ");
}

function safeJson(value: unknown) {
  return JSON.stringify(value)!.replace(/</g, "\\u003c");
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
