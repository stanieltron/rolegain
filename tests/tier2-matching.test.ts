import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  JobOpportunity,
  JobSearchWorkspace,
} from "../src/contracts/job-search.js";
import type { CodexExecClient } from "../src/codex-runtime/client.js";
import { LiveOpportunityResearcher } from "../src/03-match/opportunity-researcher.js";

describe("Tier 2 requirement matching", () => {
  it("refuses to match from noncanonical source notes", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "rolegain-tier2-"));
    const codex = {
      start: async () => ({
        authenticated: true,
        model: "test-model",
        models: [{ id: "test-model" }],
      }),
      startThread: async ({ role }: { role: string }) => ({ id: role }),
      runTurn: async () => {
        throw new Error("Matching must stop before an LLM turn");
      },
    } as unknown as CodexExecClient;
    const workspace = {
      candidateId: "candidate-1",
      intelligence: { status: "ready" },
      sources: [
        {
          id: "source-dex",
          kind: "repository",
          name: "dex",
          content: "Unverified source notes",
          status: "ready",
          insights: [],
          addedAt: new Date().toISOString(),
        },
      ],
    } as unknown as JobSearchWorkspace;
    const job = {
      id: "job-1",
      company: "Dex Co",
      title: "DeFi Infrastructure Engineer",
      location: "Remote",
      workplace: "Remote",
      compensation: "",
      sourceUrl: "https://example.test/job",
      applyUrl: "https://example.test/apply",
      capturedAt: new Date().toISOString(),
      fit: 0,
      summary: "Build complex, scalable DeFi systems.",
      description: "Required: Experience building complex, scalable DeFi systems",
      requirements: [],
      requirementMatches: [],
      strengths: [],
      gaps: [],
    } satisfies JobOpportunity;
    const researcher = new LiveOpportunityResearcher(codex, dataRoot, dataRoot);

    await expect(researcher.assess(workspace, [job])).resolves.toMatchObject({
      opportunities: [],
      failures: [
        {
          stage: "requirements",
          reason:
            "A canonical evidence run is required before requirement matching",
        },
      ],
    });
  });
});
