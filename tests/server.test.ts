import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRolegainApp, type RolegainApp } from "../src/server/app.js";

let app: RolegainApp | undefined;

afterEach(async () => {
  if (app) {
    await new Promise<void>((resolve) => app!.server.close(() => resolve()));
    await app.codex.close();
    app = undefined;
  }
});

describe("HTTP surface", () => {
  it("serves health and controls background execution", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-server-"));
    app = await createRolegainApp({ rootDir: root });
    const port = await app.start(0);
    const health = await fetch(`http://127.0.0.1:${port}/api/health`).then(
      (response) => response.json(),
    );
    expect(health).toMatchObject({ ok: true });

    const stopped = (await fetch(
      `http://127.0.0.1:${port}/api/job-search/background/stop`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    ).then((response) => response.json())) as {
      backgroundExecution: { state: string };
    };
    expect(stopped.backgroundExecution.state).toBe("stopped");

    const continued = (await fetch(
      `http://127.0.0.1:${port}/api/job-search/background/continue`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    ).then((response) => response.json())) as {
      backgroundExecution: { state: string };
    };
    expect(continued.backgroundExecution.state).toBe("running");
  });

  it("exposes the curated job-search workspace", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "rolegain-workspace-server-"),
    );
    app = await createRolegainApp({ rootDir: root });
    const port = await app.start(0);
    const base = `http://127.0.0.1:${port}`;
    const initial = (await fetch(`${base}/api/job-search`).then((response) =>
      response.json(),
    )) as { phase: string; questions: unknown[] };
    expect(initial.phase).toBe("intake");
    expect(initial.questions).toHaveLength(5);
    const candidate = (await fetch(`${base}/api/job-search/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Nina Novak",
        email: "nina@example.test",
        location: "Bratislava",
      }),
    }).then((response) => response.json())) as { profile: { name: string } };
    expect(candidate.profile.name).toBe("Nina Novak");
  });

  it("creates a same-origin employer iframe session for an owned application", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-proxy-session-"));
    app = await createRolegainApp({ rootDir: root });
    const workspace = await app.jobSearch.addOpportunity({
      company: "Example Employer",
      title: "Platform Engineer",
      applyUrl: "https://jobs.example.com/roles/platform/application",
    });
    const application = workspace.applications[0];
    const port = await app.start(0);
    const base = `http://127.0.0.1:${port}`;

    const response = await fetch(
      `${base}/api/job-search/applications/${application.id}/employer-proxy-session`,
      { method: "POST" },
    );
    const session = (await response.json()) as { url: string };

    expect(response.status).toBe(201);
    expect(session.url).toMatch(
      /^\/__rolegain_employer_proxy\/[^/]+\/roles\/platform\/application$/,
    );
    expect(session.url).not.toContain(".localhost");

    const rejected = await fetch(
      `${base}/__rolegain_employer_proxy/not-a-valid-token/application`,
    );
    expect(rejected.status).toBe(403);
  });

  it("creates a same-origin vacancy iframe session for an owned application", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-vacancy-session-"));
    app = await createRolegainApp({ rootDir: root });
    const workspace = await app.jobSearch.addOpportunity({
      company: "Example Employer",
      title: "Platform Engineer",
      sourceUrl: "https://jobs.example.com/roles/platform",
      applyUrl: "https://jobs.example.com/roles/platform/application",
    });
    const application = workspace.applications[0];
    const port = await app.start(0);
    const base = `http://127.0.0.1:${port}`;

    const response = await fetch(
      `${base}/api/job-search/applications/${application.id}/vacancy-proxy-session`,
      { method: "POST" },
    );
    const session = (await response.json()) as { url: string };

    expect(response.status).toBe(201);
    expect(session.url).toMatch(
      /^\/__rolegain_employer_proxy\/[^/]+\/roles\/platform$/,
    );
    expect(session.url).not.toContain("/application");
  });

  it("serves the byte-identical original candidate document inline", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "rolegain-original-server-"),
    );
    app = await createRolegainApp({ rootDir: root });
    const port = await app.start(0);
    const original = Buffer.from(
      "Candidate Name\ncandidate@example.test\nSenior platform engineer",
    );
    const workspace = await app.jobSearch.addSource({
      kind: "cv",
      name: "candidate-cv.txt",
      mimeType: "text/plain",
      dataBase64: original.toString("base64"),
    });
    const response = await fetch(
      `http://127.0.0.1:${port}/api/job-search/candidates/${workspace.candidateId}/sources/${workspace.sources[0].id}/file`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("inline");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(original);
  });

  it("returns a UI-safe validation error without replacing the current CV", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "rolegain-invalid-cv-server-"),
    );
    app = await createRolegainApp({ rootDir: root });
    const port = await app.start(0);
    const current = await app.jobSearch.addSource({
      kind: "cv",
      name: "working-cv.txt",
      dataBase64: Buffer.from(
        "Working candidate evidence for platform engineering.",
      ).toString("base64"),
    });
    const currentCv = current.sources.find((source) => source.kind === "cv")!;

    const response = await fetch(
      `http://127.0.0.1:${port}/api/job-search/sources`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "cv",
          name: "empty-replacement.pdf",
          dataBase64: "",
        }),
      },
    );
    const error = (await response.json()) as { error: string; code: string };

    expect(response.status).toBe(422);
    expect(error).toEqual({
      code: "CV_NOT_OPENABLE",
      error: expect.stringContaining("CV could not be opened"),
    });
    const after = await app.jobSearch.get();
    expect(after.sources.find((source) => source.kind === "cv")?.id).toBe(
      currentCv.id,
    );
  });
});
