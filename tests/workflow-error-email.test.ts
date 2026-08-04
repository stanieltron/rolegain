import { describe, expect, it, vi } from "vitest";
import {
  classifyWorkflowFailure,
  createWorkflowFailureNotifier,
  sanitizeWorkflowError,
} from "../src/backend/notifications/workflow-error-email.js";

describe("workflow failure email alerts", () => {
  it("classifies common operational failures", () => {
    expect(classifyWorkflowFailure("Invalid refresh token, sign in again"))
      .toBe("codex_auth");
    expect(classifyWorkflowFailure("EMAXCONNSESSION max clients reached"))
      .toBe("database_capacity");
    expect(classifyWorkflowFailure("worker heartbeat expired"))
      .toBe("timeout");
  });

  it("redacts credentials and bounds the error sent by email", () => {
    const sanitized = sanitizeWorkflowError(
      `Bearer secret-token refresh_token=very-secret password=hunter2 ${"x".repeat(3_000)}`,
    );
    expect(sanitized).not.toContain("secret-token");
    expect(sanitized).not.toContain("very-secret");
    expect(sanitized).not.toContain("hunter2");
    expect(sanitized.length).toBeLessThanOrEqual(2_000);
  });

  it("sends one idempotent plain-text alert to the configured administrator", async () => {
    const requests: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const request: typeof fetch = async (input, init) => {
      requests.push([input, init]);
      return new Response("{}", { status: 200 });
    };
    const notify = createWorkflowFailureNotifier(
      {
        apiKey: "re_test",
        to: "admin@example.com",
        from: "Rolegain <alerts@example.com>",
        adminUrl: "https://rolegain.example/admin",
      },
      request,
    );

    await notify({
      runId: "run-1",
      userId: "user-1",
      userEmail: "user@example.com",
      workflowType: "analyze",
      error: "Invalid refresh token Bearer private-value",
      occurredAt: "2026-08-04T18:00:00.000Z",
    });

    expect(requests).toHaveLength(1);
    const [url, init] = requests[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer re_test",
    });
    expect((init?.headers as Record<string, string>)["Idempotency-Key"])
      .toMatch(/^workflow-failed\/run-1\/[a-f0-9]{32}$/);
    const body = JSON.parse(String(init?.body));
    expect(body.to).toEqual(["admin@example.com"]);
    expect(body.subject).toContain("codex_auth");
    expect(body.text).not.toContain("private-value");
  });

  it("changes the idempotency key when a retried run has a different body", async () => {
    const keys: string[] = [];
    const request: typeof fetch = async (_input, init) => {
      keys.push((init?.headers as Record<string, string>)["Idempotency-Key"]);
      return new Response("{}", { status: 200 });
    };
    const notify = createWorkflowFailureNotifier(
      { apiKey: "re_test", to: "admin@example.com" },
      request,
    );
    const alert = {
      runId: "run-1",
      userId: "user-1",
      workflowType: "analyze",
      error: "first failure",
      occurredAt: "2026-08-04T18:00:00.000Z",
    };

    await notify(alert);
    await notify(alert);
    await notify({ ...alert, error: "second failure" });

    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("is disabled when no recipient or API key is configured", async () => {
    const request = vi.fn();
    await createWorkflowFailureNotifier({}, request as typeof fetch)({
      runId: "run-1",
      userId: "user-1",
      workflowType: "analyze",
      error: "failure",
      occurredAt: "2026-08-04T18:00:00.000Z",
    });
    expect(request).not.toHaveBeenCalled();
  });
});
