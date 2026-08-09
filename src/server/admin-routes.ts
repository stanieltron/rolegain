import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import type { PlatformControl } from "../backend/admin/platform-control.js";
import type { JobSearchService } from "../backend/control-flow/service.js";
import type { ArtifactArchive } from "../backend/persistence/artifact-archive.js";
import { safeUserId } from "../backend/persistence/workspace-store.js";
import type { WorkflowQueue } from "../backend/workflows/workflow-queue.js";
import type { RuntimeConfiguration } from "../config/runtime.js";
import { withUserLock } from "../infrastructure/database.js";
import { readJson, sendJson } from "./http.js";
import { HttpError, type UserAccountAdmin } from "./auth.js";

const SESSION_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60_000;
const MAX_LOGIN_ATTEMPTS = 8;

interface LoginWindow {
  startedAt: number;
  attempts: number;
}

interface AdminUserOperations {
  jobSearch: JobSearchService;
  artifacts: ArtifactArchive;
  accounts: UserAccountAdmin;
  lockPool?: Pool;
}

export class AdminRoutes {
  private readonly loginAttempts = new Map<string, LoginWindow>();

  constructor(
    private readonly configuration: RuntimeConfiguration,
    private readonly platform: PlatformControl,
    private readonly workflows?: WorkflowQueue,
    private readonly userOperations?: AdminUserOperations,
  ) {}

  matches(pathname: string) {
    return pathname.startsWith("/api/admin/");
  }

  async route(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ) {
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "POST" && pathname === "/api/admin/login") {
      this.enforceLoginRate(request);
      this.assertConfigured();
      const body = await readJson(request);
      const username = typeof body.username === "string" ? body.username : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (
        !safeEqual(username, this.configuration.adminUsername!) ||
        !safeEqual(password, this.configuration.adminPassword!)
      )
        throw new HttpError(
          401,
          "Invalid administrator credentials",
          "invalid_admin_credentials",
        );
      this.clearLoginRate(request);
      response.setHeader(
        "Set-Cookie",
        adminCookie(
          this.signSession(),
          this.configuration.authMode === "supabase",
        ),
      );
      sendJson(response, 200, { authenticated: true });
      return;
    }

    if (request.method === "POST" && pathname === "/api/admin/logout") {
      response.setHeader(
        "Set-Cookie",
        clearAdminCookie(this.configuration.authMode === "supabase"),
      );
      sendJson(response, 200, { authenticated: false });
      return;
    }

    this.assertAuthenticated(request);
    if (request.method === "GET" && pathname === "/api/admin/overview") {
      sendJson(response, 200, await this.platform.adminOverview());
      return;
    }
    if (request.method === "POST" && pathname === "/api/admin/codex") {
      const body = await readJson(request);
      if (typeof body.enabled !== "boolean")
        throw new HttpError(
          400,
          "enabled must be a boolean",
          "invalid_admin_request",
        );
      sendJson(
        response,
        200,
        await this.platform.setCodexEnabled(body.enabled),
      );
      return;
    }
    if (
      request.method === "POST" &&
      pathname === "/api/admin/evidence-chunk-limit"
    ) {
      const body = await readJson(request);
      sendJson(
        response,
        200,
        await this.platform.setEvidenceChunkLimit(
          typeof body.limit === "number" ? body.limit : Number.NaN,
        ),
      );
      return;
    }
    const userLimitMatch = pathname.match(
      /^\/api\/admin\/users\/([^/]+)\/application-limit$/,
    );
    if (request.method === "POST" && userLimitMatch) {
      const body = await readJson(request);
      sendJson(
        response,
        200,
        await this.platform.setUserApplicationLimit(
          parseUserId(userLimitMatch[1]),
          typeof body.limit === "number" ? body.limit : Number.NaN,
        ),
      );
      return;
    }
    const validationReplayMatch = pathname.match(
      /^\/api\/admin\/users\/([^/]+)\/revalidate-search$/,
    );
    if (request.method === "POST" && validationReplayMatch) {
      if (!this.workflows)
        throw new HttpError(
          503,
          "Background workflows are not configured",
          "workflows_not_configured",
        );
      sendJson(
        response,
        202,
        await this.workflows.enqueue(
          parseUserId(validationReplayMatch[1]),
          "revalidate-search",
          { reserveBetaBatch: false },
        ),
      );
      return;
    }
    const resetStatisticsMatch = pathname.match(
      /^\/api\/admin\/users\/([^/]+)\/reset-statistics$/,
    );
    if (request.method === "POST" && resetStatisticsMatch) {
      const userId = parseUserId(resetStatisticsMatch[1]);
      await this.withUserLock(userId, () =>
        this.platform.resetUserStatistics(userId)
      );
      sendJson(response, 200, { userId, statisticsReset: true });
      return;
    }
    const removeUserMatch = pathname.match(
      /^\/api\/admin\/users\/([^/]+)$/,
    );
    if (request.method === "DELETE" && removeUserMatch) {
      if (!this.userOperations)
        throw new HttpError(
          503,
          "User removal is not configured",
          "user_removal_not_configured",
        );
      const userId = parseUserId(removeUserMatch[1]);
      await this.workflows?.cancel(userId);
      await this.withUserLock(userId, async () => {
        await this.workflows?.purgeUserJobs(userId);
        await this.userOperations!.artifacts.delete(userId);
        await this.userOperations!.jobSearch.deleteUserCompletely(userId);
        await this.platform.removeUserRecords(userId);
        await this.userOperations!.accounts.delete(userId);
      });
      sendJson(response, 200, { userId, removed: true });
      return;
    }
    throw new HttpError(404, "Admin route not found", "not_found");
  }

  private async withUserLock<T>(userId: string, work: () => Promise<T>) {
    if (!this.userOperations?.lockPool) return work();
    return withUserLock(this.userOperations.lockPool, userId, work);
  }

  private assertConfigured() {
    if (
      !this.configuration.adminUsername ||
      !this.configuration.adminPassword ||
      !this.configuration.adminSessionSecret ||
      this.configuration.adminSessionSecret.length < 32
    )
      throw new HttpError(
        503,
        "Administrator access is not configured",
        "admin_not_configured",
      );
  }

  private assertAuthenticated(request: IncomingMessage) {
    this.assertConfigured();
    const cookie = request.headers.cookie
      ?.split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith("rolegain_admin="))
      ?.slice("rolegain_admin=".length);
    if (!cookie || !this.verifySession(cookie))
      throw new HttpError(
        401,
        "Administrator authentication required",
        "admin_unauthenticated",
      );
  }

  private signSession() {
    const payload = Buffer.from(
      JSON.stringify({
        sub: this.configuration.adminUsername,
        exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
      }),
    ).toString("base64url");
    return `${payload}.${this.signature(payload)}`;
  }

  private verifySession(token: string) {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) return false;
    if (!safeEqual(signature, this.signature(payload))) return false;
    try {
      const parsed = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as { sub?: unknown; exp?: unknown };
      return (
        parsed.sub === this.configuration.adminUsername &&
        typeof parsed.exp === "number" &&
        parsed.exp > Math.floor(Date.now() / 1000)
      );
    } catch {
      return false;
    }
  }

  private signature(payload: string) {
    return createHmac(
      "sha256",
      this.configuration.adminSessionSecret!,
    ).update(payload).digest("base64url");
  }

  private enforceLoginRate(request: IncomingMessage) {
    const key = request.socket.remoteAddress || "unknown";
    const now = Date.now();
    const current = this.loginAttempts.get(key);
    const window =
      !current || now - current.startedAt > LOGIN_WINDOW_MS
        ? { startedAt: now, attempts: 0 }
        : current;
    window.attempts += 1;
    this.loginAttempts.set(key, window);
    if (window.attempts > MAX_LOGIN_ATTEMPTS)
      throw new HttpError(
        429,
        "Too many administrator login attempts",
        "admin_rate_limited",
      );
  }

  private clearLoginRate(request: IncomingMessage) {
    this.loginAttempts.delete(request.socket.remoteAddress || "unknown");
  }
}

function safeEqual(left: string, right: string) {
  return timingSafeEqual(
    createHash("sha256").update(left).digest(),
    createHash("sha256").update(right).digest(),
  );
}

function parseUserId(value: string) {
  try {
    return safeUserId(decodeURIComponent(value));
  } catch {
    throw new HttpError(400, "Invalid user identifier", "invalid_user_id");
  }
}

function adminCookie(token: string, secure: boolean) {
  return [
    `rolegain_admin=${token}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/api/admin",
    `Max-Age=${SESSION_SECONDS}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function clearAdminCookie(secure: boolean) {
  return [
    "rolegain_admin=",
    "HttpOnly",
    "SameSite=Strict",
    "Path=/api/admin",
    "Max-Age=0",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
