import { describe, expect, it } from "vitest";
import {
  proxiedEmployerHost,
  rewriteEmployerHtml,
} from "../src/server/employer-proxy.js";
import {
  createEmployerProxySession,
  employerProxyUrl,
  verifyEmployerProxySession,
} from "../src/server/employer-proxy-session.js";

describe("embedded employer browser host routing", () => {
  it("extracts a public employer hostname from its localhost browser origin", () => {
    expect(proxiedEmployerHost("jobs.ashbyhq.com.localhost:4317")).toBe(
      "jobs.ashbyhq.com",
    );
  });

  it("does not turn ordinary local or IP hosts into proxy targets", () => {
    expect(proxiedEmployerHost("127.0.0.1:4317")).toBeUndefined();
    expect(proxiedEmployerHost("localhost:4317")).toBeUndefined();
    expect(proxiedEmployerHost("169.254.169.254.localhost:4317")).toBeUndefined();
  });

  it("issues tamper-resistant, expiring sessions for Railway iframe paths", () => {
    const secret = "test-employer-proxy-secret";
    const targetUrl = "https://jobs.ashbyhq.com/acme/job-1/application?source=test";
    const token = createEmployerProxySession(
      {
        userId: "user-1",
        applicationId: "application-1",
        targetUrl,
        expiresAt: 2_000,
      },
      secret,
    );

    expect(verifyEmployerProxySession(token, secret, 1_000)).toMatchObject({
      userId: "user-1",
      applicationId: "application-1",
      targetUrl,
    });
    expect(verifyEmployerProxySession(`${token}x`, secret, 1_000)).toBeUndefined();
    expect(verifyEmployerProxySession(token, secret, 2_001)).toBeUndefined();
    expect(employerProxyUrl(token, targetUrl)).toBe(
      `/__rolegain_employer_proxy/${token}/acme/job-1/application?source=test`,
    );
  });

  it("keeps same-employer resources inside the signed path proxy", () => {
    const rewritten = rewriteEmployerHtml(
      `<script src="/assets/app.js"></script><form action="https://jobs.ashbyhq.com/apply"></form><a href="https://example.com/help">Help</a><style>.logo{background:url('/logo.svg')}</style>`,
      new URL("https://jobs.ashbyhq.com/acme/application"),
      "/__rolegain_employer_proxy/signed-token",
    );

    expect(rewritten).toContain(
      'src="/__rolegain_employer_proxy/signed-token/assets/app.js"',
    );
    expect(rewritten).toContain(
      'action="/__rolegain_employer_proxy/signed-token/apply"',
    );
    expect(rewritten).toContain(
      "url('/__rolegain_employer_proxy/signed-token/logo.svg')",
    );
    expect(rewritten).toContain('href="https://example.com/help"');
  });
});
