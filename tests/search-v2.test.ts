import { describe, expect, it } from "vitest";
import { runtimeConfiguration } from "../src/config/runtime.js";
import { searchImplementationFor } from "../src/search-discovery.js";
import { searchV2Configuration } from "../src/02-search-v2/config.js";
import {
  extractSignals,
  inaccessibleDecision,
} from "../src/02-search-v2/harness/capture.js";
import { buildClassificationPrompt } from "../src/02-search-v2/harness/prompts.js";
import { validatedDiscoveryTargetV2 } from "../src/02-search-v2/index.js";
import type {
  SearchV2Capture,
  SearchV2Lead,
} from "../src/02-search-v2/contracts.js";

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
    expect(inaccessibleDecision(capture)).toBeUndefined();
  });

  it("bypasses the model only when both capture paths yield no evidence", () => {
    const empty = makeCapture({
      httpStatus: 0,
      pageTitle: "",
      body: "",
      links: [],
      navigationError: "Download is starting",
    });
    empty.signals = extractSignals(empty);
    expect(inaccessibleDecision(empty)?.status).toBe("reject");

    const recovered = makeCapture({
      httpStatus: 403,
      pageTitle: "",
      body: "Distributed Systems Engineer About the role Build protocol infrastructure.",
    });
    recovered.signals = extractSignals(recovered);
    expect(inaccessibleDecision(recovered)).toBeUndefined();
  });

  it("uses the same full-round target semantics as the current pipeline", () => {
    expect(validatedDiscoveryTargetV2(20, 5)).toBe(13);
    expect(validatedDiscoveryTargetV2(4, 5)).toBe(4);
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
      hasUsableEvidence: false,
    },
    ...values,
  };
}
