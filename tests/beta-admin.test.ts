import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BETA_APPLICATION_LIMIT,
  PlatformControl,
} from "../src/backend/admin/platform-control.js";
import { createRolegainApp, type RolegainApp } from "../src/server/app.js";

let app: RolegainApp | undefined;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  vi.unstubAllEnvs();
});

describe("closed beta controls", () => {
  it("allows exactly two application batches and ten unique applications", async () => {
    const platform = new PlatformControl();
    const first = await platform.reserveBatch("user-a");
    expect(first.batchesStarted).toBe(1);
    await platform.recordApplications(
      "user-a",
      Array.from({ length: 5 }, (_, index) => `application-${index + 1}`),
    );

    const second = await platform.reserveBatch("user-a");
    expect(second.batchesStarted).toBe(2);
    await platform.recordApplications(
      "user-a",
      Array.from({ length: 6 }, (_, index) => `application-${index + 5}`),
    );

    const complete = await platform.betaStatus("user-a");
    expect(complete).toMatchObject({
      applicationsUsed: BETA_APPLICATION_LIMIT,
      remainingApplications: 0,
      remainingBatches: 0,
      canStartBatch: false,
    });
    await expect(platform.reserveBatch("user-a")).rejects.toMatchObject({
      status: 403,
      code: "beta_limit_reached",
    });

    const extended = await platform.setUserApplicationLimit("user-a", 20);
    expect(extended).toMatchObject({
      applicationLimit: 20,
      remainingApplications: 10,
      batchLimit: 4,
      remainingBatches: 2,
      canStartBatch: true,
    });
    await platform.reserveBatch("user-a");
    await platform.reserveBatch("user-a");
    await expect(platform.reserveBatch("user-a")).rejects.toMatchObject({
      code: "beta_limit_reached",
    });
  });

  it("persists the maintenance switch and blocks new Codex work", async () => {
    const platform = new PlatformControl();
    await platform.setCodexEnabled(false);
    expect(await platform.serviceStatus()).toMatchObject({
      codexEnabled: false,
    });
    await expect(platform.assertCodexEnabled()).rejects.toMatchObject({
      status: 503,
      code: "codex_maintenance",
    });
    await platform.setCodexEnabled(true);
    await expect(platform.assertCodexEnabled()).resolves.toBeUndefined();
  });
});

describe.sequential("administrator HTTP surface", () => {
  it("uses a private cookie session and controls maintenance mode", async () => {
    vi.stubEnv("ROLEGAIN_ADMIN_USERNAME", "admin-test");
    vi.stubEnv("ROLEGAIN_ADMIN_PASSWORD", "correct-horse-battery-staple");
    vi.stubEnv(
      "ROLEGAIN_ADMIN_SESSION_SECRET",
      "test-only-admin-session-secret-with-32-characters",
    );
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-admin-"));
    app = await createRolegainApp({ rootDir: root });
    const port = await app.start(0);
    const base = `http://127.0.0.1:${port}`;

    const anonymous = await fetch(`${base}/api/admin/overview`);
    expect(anonymous.status).toBe(401);

    const invalid = await fetch(`${base}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin-test", password: "wrong" }),
    });
    expect(invalid.status).toBe(401);

    const login = await fetch(`${base}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "admin-test",
        password: "correct-horse-battery-staple",
      }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie()[0].split(";")[0];
    expect(cookie).toMatch(/^rolegain_admin=/);

    const overview = await fetch(`${base}/api/admin/overview`, {
      headers: { Cookie: cookie },
    });
    expect(overview.status).toBe(200);
    expect(await overview.json()).toMatchObject({
      service: { codexEnabled: true },
    });

    const raised = await fetch(
      `${base}/api/admin/users/test-user/application-limit`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ limit: 25 }),
      },
    );
    expect(raised.status).toBe(200);
    expect(await raised.json()).toMatchObject({
      applicationLimit: 25,
      batchLimit: 5,
    });

    const paused = await fetch(`${base}/api/admin/codex`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled: false }),
    });
    expect(paused.status).toBe(200);

    const service = await fetch(`${base}/api/service-status`);
    expect(await service.json()).toMatchObject({ codexEnabled: false });

    const blocked = await fetch(`${base}/api/job-search/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toMatchObject({
      code: "codex_maintenance",
    });
  });
});
