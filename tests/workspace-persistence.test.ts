import { describe, expect, it } from "vitest";
import { mockWorkspace } from "../src/01-evidence-ingestion/inspection/fixtures.js";
import { durableWorkspace } from "../src/backend/persistence/workspace-store.js";

describe("workspace persistence", () => {
  it("keeps display-only analysis state out of the durable JSONB payload", () => {
    const workspace = mockWorkspace();
    workspace.intelligence = {
      status: "analyzing",
      progress: {
        stage: "reading",
        completed: 7,
        total: 20,
        sourceName: "CV",
      },
    };

    const durable = durableWorkspace(workspace);

    expect(durable.intelligence).toEqual({ status: "idle" });
    expect(workspace.intelligence.status).toBe("analyzing");
    expect(workspace.intelligence.progress?.completed).toBe(7);
  });

  it("retains the last completed evidence state while a refresh is running", () => {
    const workspace = mockWorkspace();
    workspace.intelligence = {
      status: "analyzing",
      progress: { stage: "synthesizing", completed: 20, total: 20 },
      evidenceRun: {
        id: "evidence-existing",
        readyForSearch: true,
        blockers: [],
        warnings: [],
        counts: {
          sources: 1,
          sourceBlocks: 2,
          claims: 3,
          supportedClaims: 3,
          capabilities: 2,
          roleFamilies: 1,
          unknowns: 0,
          contradictions: 0,
        },
      },
    };

    expect(durableWorkspace(workspace).intelligence).toMatchObject({
      status: "ready",
      evidenceRun: { id: "evidence-existing" },
      progress: undefined,
    });
  });
});
