import { describe, expect, it } from "vitest";
import { proxiedEmployerHost } from "../src/server/employer-proxy.js";

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
});
