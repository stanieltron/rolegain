import { describe, expect, it } from "vitest";
import { googleOAuthOptions } from "../src/ui/auth.js";

describe("Google authentication", () => {
  it("always asks Google which account should be used", () => {
    expect(googleOAuthOptions("https://rolegain.example")).toEqual({
      redirectTo: "https://rolegain.example",
      queryParams: { prompt: "select_account" },
    });
  });
});
