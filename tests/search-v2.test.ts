import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runtimeConfiguration } from "../src/config/runtime.js";
import { searchImplementationFor } from "../src/search-discovery.js";
import { searchV2Configuration } from "../src/02-search/v2/config.js";
import {
  extractSignals,
  parseFallbackHtml,
} from "../src/02-search/v2/harness/capture.js";
import {
  classifySearchV2Captures,
  discoverSearchV2Leads,
} from "../src/02-search/v2/harness/model.js";
import { buildClassificationPrompt } from "../src/02-search/v2/harness/prompts.js";
import {
  mergeSearchSourceBacklog,
  prioritizeSearchSourceBacklog,
  recoverSearchSourceBacklog,
  validatedDiscoveryTargetV2,
} from "../src/02-search/v2/index.js";
import { searchV2Failure } from "../src/02-search/v2/support/opportunity.js";
import { deduplicateFailures } from "../src/search-match-shared/opportunity.js";
import { mockWorkspaceWithCv } from "../src/01-evidence-ingestion/inspection/fixtures.js";
import type { CodexExecClient } from "../src/codex-runtime/client.js";
import type { Phase2EvidenceContext } from "../src/search-match-shared/evidence-context.js";
import type {
  SearchV2Capture,
  SearchV2Lead,
} from "../src/02-search/v2/contracts.js";
import type { SearchSourceBacklogItem } from "../src/contracts/job-search.js";

describe("search v2", () => {
  it("is explicitly selectable without changing the v1 default", () => {
    expect(runtimeConfiguration({}).searchVersion).toBe("v1");
    expect(
      runtimeConfiguration({ ROLEGAIN_SEARCH_VERSION: "v2" }).searchVersion,
    ).toBe("v2");
    expect(searchImplementationFor("v1").name).toBe(
      "searchAndValidateOpportunities",
    );
    expect(searchImplementationFor("v2").name).toBe(
      "searchAndValidateOpportunitiesV2",
    );
  });

  it("uses speed-oriented bounded defaults", () => {
    expect(searchV2Configuration({})).toMatchObject({
      captureConcurrency: 10,
      classificationBatchSize: 32,
      classificationConcurrency: 3,
      maxWaves: 4,
      childrenPerSource: 20,
    });
    expect(
      searchV2Configuration({
        ROLEGAIN_SEARCH_V2_BATCH_SIZE: "500",
        ROLEGAIN_SEARCH_V2_CAPTURE_CONCURRENCY: "0",
      }),
    ).toMatchObject({
      captureConcurrency: 1,
      classificationBatchSize: 48,
    });
  });

  it("retains full-page closure and staffing signals beyond compact body", () => {
    const capture = makeCapture({
      body:
        `${"role description ".repeat(400)}\n` +
        "Applications for this job are currently closed. This is also an open application for several teams.",
    });
    capture.signals = extractSignals(capture);
    const prompt = buildClassificationPrompt([capture]);
    expect(capture.body.length).toBeGreaterThan(3_500);
    expect(capture.signals.definiteClosureContext).toContain(
      "currently closed",
    );
    expect(capture.signals.staffingPoolContext).toContain("open application");
    expect(prompt).toContain("currently closed");
    expect(prompt).toContain("open application");
  });

  it("preserves exact application-loading evidence", () => {
    const capture = makeCapture({
      pageTitle: "Distributed Systems Engineer - Windmill",
      body: "Loading application form...",
    });
    capture.signals = extractSignals(capture);
    expect(capture.signals.pageTitleMatchesExpected).toBe(true);
    expect(capture.signals.applicationLoadingContext).toContain(
      "Loading application form",
    );
  });

  it("recovers an Ashby-style vacancy from metadata and its apply link", () => {
    const parsed = parseFallbackHtml(
      `<!doctype html><html><head>
        <title>Protocol Engineer @ Example</title>
        <meta name="description" content="Build and verify a production blockchain protocol using Rust and Solidity.">
      </head><body><div id="root"></div>
        <a href="/application">Apply here</a>
      </body></html>`,
      "https://jobs.ashbyhq.com/example/job-1",
    );

    expect(parsed.pageTitle).toBe("Protocol Engineer @ Example");
    expect(parsed.body).toContain("production blockchain protocol");
    expect(parsed.links).toContainEqual({
      text: "Apply here",
      url: "https://jobs.ashbyhq.com/application",
    });
  });

  it("gives Codex live web recovery when the deterministic capture is empty", async () => {
    const modes: string[] = [];
    const empty = makeCapture({
      pageTitle: "",
      body: "",
      links: [],
    });
    empty.signals = extractSignals(empty);
    const codex = {
      start: async () => ({ authenticated: true, model: "test-model" }),
      startThread: async (options: { webSearch?: { mode?: string } }) => {
        modes.push(options.webSearch?.mode || "");
        return { id: "recovery", modelProvider: "openai" };
      },
      runTurn: async () => ({
        threadId: "recovery",
        turnId: "turn-recovery",
        status: "completed" as const,
        finalText: JSON.stringify({
          results: [{
            id: empty.id,
            status: "vacancy",
            reason: "The live page is a current individual vacancy.",
            title: empty.lead.title,
            company: empty.lead.company,
            location: "Remote",
            workplaceType: "Remote",
            employmentType: "Full-time",
            applyUrl: empty.lead.url,
            compensation: "",
            children: [],
          }],
        }),
        items: [],
      }),
    } as unknown as CodexExecClient;

    const decisions = await classifySearchV2Captures({
      codex,
      cwd: process.cwd(),
      captures: [empty],
      configuration: searchV2Configuration({}),
    });

    expect(modes).toEqual(["live"]);
    expect(decisions[0].status).toBe("vacancy");
  });

  it("searches deeply enough to absorb downstream form and match losses", () => {
    expect(validatedDiscoveryTargetV2(20, 5)).toBe(20);
    expect(validatedDiscoveryTargetV2(30, 5)).toBe(26);
    expect(validatedDiscoveryTargetV2(4, 5)).toBe(4);
  });

  it("keeps deferred list children for later batches without duplicating them", () => {
    const first = backlogItem("one", "Protocol Engineer");
    const duplicate = { ...first, id: "duplicate" };
    const second = backlogItem("two", "Rust Engineer");

    expect(mergeSearchSourceBacklog([first], [duplicate, second])).toEqual([
      first,
      second,
    ]);
    expect(
      mergeSearchSourceBacklog([first], [second], new Set([
        "protocol engineer::https://jobs.example.test/list",
      ])),
    ).toEqual([second]);
  });

  it("only hard-rejects confirmed closure or a location mismatch", () => {
    const lead = makeCapture().lead;
    expect(
      searchV2Failure(
        lead,
        'Definite closure signal: "This job is no longer accepting applications".',
      ).disposition,
    ).toBe("rejected");
    expect(
      searchV2Failure(
        lead,
        "Workplace or location does not match the candidate constraint",
      ).disposition,
    ).toBe("rejected");
    expect(
      searchV2Failure(lead, "Application link returned 404").disposition,
    ).toBe("unresolved");
    expect(
      searchV2Failure(
        lead,
        "The browser and HTTP fallback produced no usable current-page evidence.",
      ).disposition,
    ).toBe("manual_review");
  });

  it("does not collapse different jobs that came from one marketplace list", () => {
    const first = searchV2Failure(
      { ...makeCapture().lead, title: "Protocol Engineer", company: "Alpha" },
      "No reachable employer application form was found",
    );
    const second = searchV2Failure(
      { ...makeCapture().lead, title: "Rust Engineer", company: "Beta" },
      "No reachable employer application form was found",
    );
    expect(deduplicateFailures([first, second])).toHaveLength(2);
  });

  it("recovers retryable direct jobs from older workspace history", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "rolegain-search-v2-"));
    const workspace = mockWorkspaceWithCv();
    workspace.jobHistory = [
      pipelineItem("retry", "Application link returned 404"),
      pipelineItem(
        "closed",
        'Definite closure signal: "This job is no longer accepting applications".',
      ),
    ];

    const recovered = await recoverSearchSourceBacklog({
      dataRoot,
      candidateId: workspace.candidateId,
      workspace,
      childrenPerSource: 20,
    });

    expect(recovered.map((item) => item.id)).toEqual(["retry"]);
  });

  it("checks role-relevant saved children before unrelated jobs from the same list", () => {
    const finance = backlogItem("finance", "Finance Intern");
    const protocol = backlogItem("protocol", "Protocol Risk Lead");
    const rust = backlogItem("rust", "Rust Engineer");
    const ranked = prioritizeSearchSourceBacklog(
      [finance, protocol, rust],
      {
        searchLanes: [{
          canonicalTitle: "Protocol Architect",
          titleAliases: ["Protocol Engineer", "Rust Engineer"],
          leadingCapabilities: ["Protocol architecture"],
          toolsMethods: ["Rust"],
        }],
      } as unknown as Phase2EvidenceContext,
    );

    expect(ranked.map((item) => item.id)).toEqual([
      "rust",
      "protocol",
      "finance",
    ]);
  });

  it("registers both v2 model boundaries under the canonical product call ids", async () => {
    const callIds: string[] = [];
    const codex = {
      start: async () => ({
        authenticated: true,
        model: "test-model",
      }),
      startThread: async (options: { callId?: string; role: string }) => {
        callIds.push(options.callId || "");
        return { id: options.role, modelProvider: "openai" };
      },
      runTurn: async (options: { threadId: string }) => ({
        threadId: options.threadId,
        turnId: `turn-${options.threadId}`,
        status: "completed" as const,
        finalText: JSON.stringify(
          options.threadId === "search-v2-web-discovery"
            ? {
                jobs: [{
                  title: "Protocol Engineer",
                  company: "Example",
                  location: "Remote",
                  workplaceType: "Remote",
                  employmentType: "Full-time",
                  url: "https://jobs.example.test/protocol-engineer",
                  sourceKind: "vacancy",
                  query: "protocol engineer",
                  sourceClass: "employer_ats",
                  snippet: "Protocol engineering role",
                  compensation: "",
                }],
              }
            : {
                results: [{
                  id: "lead-1",
                  status: "vacancy",
                  reason: "The expected role is present.",
                  title: "Distributed Systems Engineer",
                  company: "Windmill",
                  location: "Remote",
                  workplaceType: "Remote",
                  employmentType: "Full-time",
                  applyUrl: "https://example.com/jobs/distributed-systems-engineer",
                  compensation: "",
                  children: [],
                }],
              },
        ),
        items: [],
      }),
    } as unknown as CodexExecClient;
    const workspace = mockWorkspaceWithCv();
    const evidence = {
      searchLanes: [],
      searchVocabulary: { negativeTerms: [] },
    } as unknown as Phase2EvidenceContext;

    await discoverSearchV2Leads({
      codex,
      cwd: process.cwd(),
      workspace,
      evidence,
      requested: 1,
      wave: 0,
      excludedUrls: [],
      rejectionFeedback: [],
    });
    await classifySearchV2Captures({
      codex,
      cwd: process.cwd(),
      captures: [makeCapture()],
      configuration: searchV2Configuration({}),
    });

    expect(callIds).toEqual([
      "search.web-discovery",
      "search.vacancy-verification",
    ]);
  });
});

function makeCapture(
  values: Partial<SearchV2Capture> = {},
): SearchV2Capture {
  const lead: SearchV2Lead = {
    id: "lead-1",
    title: "Distributed Systems Engineer",
    company: "Windmill",
    location: "Remote",
    workplaceType: "Remote",
    employmentType: "Full-time",
    url: "https://example.com/jobs/distributed-systems-engineer",
    sourceKind: "vacancy",
    query: "distributed systems engineer",
    sourceClass: "employer_ats",
    snippet: "",
    compensation: "",
    wave: 1,
  };
  return {
    id: lead.id,
    lead,
    suppliedUrl: lead.url,
    finalUrl: lead.url,
    httpStatus: 200,
    navigationError: "",
    pageTitle: "Distributed Systems Engineer - Windmill",
    body: "Distributed Systems Engineer About the role",
    links: [],
    forms: [],
    signals: {
      pageTitleMatchesExpected: false,
      expectedTitleContext: "",
      definiteClosureContext: "",
      conditionalClosureContext: "",
      staffingPoolContext: "",
      applicationLoadingContext: "",
      matchingLinks: [],
      relevantLinkCount: 0,
      formCount: 0,
      hasUsableEvidence: true,
    },
    ...values,
  };
}

function backlogItem(id: string, title: string): SearchSourceBacklogItem {
  return {
    id,
    title,
    company: "Example",
    location: "Remote",
    workplaceType: "Remote",
    employmentType: "Full-time",
    sourceUrl: "https://jobs.example.test/list",
    query: "protocol engineer",
    sourceClass: "specialist_job_board",
    snippet: "",
    compensation: "",
    wave: 1,
    sourceGroup: {
      id: "source-1",
      name: "Example Jobs",
      url: "https://jobs.example.test/list",
      sourceClass: "specialist_job_board",
    },
    discoveredAt: "2026-08-09T00:00:00.000Z",
  };
}

function pipelineItem(id: string, reason: string) {
  return {
    id,
    company: "Example",
    title: `${id} Protocol Engineer`,
    sourceUrl: `https://jobs.example.test/${id}`,
    validation: "failed" as const,
    match: "waiting" as const,
    application: "waiting" as const,
    applicationVerification: "waiting" as const,
    reason,
    validationDisposition: "rejected" as const,
  };
}
