import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PlatformControl } from "../src/backend/admin/platform-control.js";

describe("administrator query shape", () => {
  it("reads workspace summaries without returning complete JSONB payloads", async () => {
    const queries: string[] = [];
    const pool = {
      async query(query: string) {
        queries.push(query.replace(/\s+/g, " ").trim());
        return { rows: [] };
      },
    } as unknown as Pool;

    await new PlatformControl(pool).adminOverview();

    expect(queries).not.toContain(
      "select user_id, payload from rolegain_workspaces",
    );
    expect(queries.some((query) =>
      query.includes("jsonb_array_length") &&
      query.includes("from rolegain_workspaces")
    )).toBe(true);
  });
});
