import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import type { CodexExecClient } from "../src/codex-runtime/client.js";
import type { JobSearchWorkspace } from "../src/contracts/job-search.js";
import type { Phase2EvidenceContext } from "../src/search-match-shared/evidence-context.js";
import type { LiveCandidate } from "../src/search-match-shared/types.js";
import type {
  SourceBrowserAgentState,
  VacancySourcePage,
} from "../src/02-search/02-vacancy-source-expansion/contracts.js";
import {
  isSafeSourceContinuationControl,
  shouldUseSourceBrowserAgent,
} from "../src/02-search/02-vacancy-source-expansion/browser-agent/policy.js";
import { appendReplayStep } from "../src/02-search/02-vacancy-source-expansion/browser-agent/run/index.js";
import { VacancySourceInventory } from "../src/02-search/02-vacancy-source-expansion/inventory/index.js";
import { runVacancySource } from "../src/02-search/02-vacancy-source-expansion/run/index.js";

const sourceUrl = "https://jobs.example.test/careers";
const source: LiveCandidate = {
  company: "Example",
  preliminaryFit: 0,
  job: {
    id: "source-browser-agent",
    title: "Example careers",
    jobUrl: sourceUrl,
    applyUrl: sourceUrl,
    sourceKind: "career_page",
  },
};

const sourcePage = (
  overrides: Partial<VacancySourcePage> = {},
): VacancySourcePage => ({
  pageUrl: sourceUrl,
  pageTitle: "Careers",
  metaDescription: "",
  h1: "Open roles",
  headings: [],
  bodyText: "Showing 1-20 of 200 results",
  applyLinks: [],
  links: [],
  interactiveContinuation: true,
  ...overrides,
});

describe("vacancy-source browser agent", () => {
  it("activates only when ordinary pagination is unavailable", () => {
    expect(shouldUseSourceBrowserAgent(sourcePage(), 20)).toBe(true);
    expect(
      shouldUseSourceBrowserAgent(
        sourcePage({ nextUrl: `${sourceUrl}?page=2` }),
        20,
      ),
    ).toBe(false);
  });

  it("allows only same-host continuation clicks", () => {
    const control = {
      id: "more",
      text: "Load more jobs",
      ariaLabel: "",
      title: "",
      href: "",
      disabled: false,
    };
    expect(isSafeSourceContinuationControl(control, sourceUrl)).toBe(true);
    expect(
      isSafeSourceContinuationControl(
        { ...control, text: "Apply now" },
        sourceUrl,
      ),
    ).toBe(false);
    expect(
      isSafeSourceContinuationControl(
        { ...control, href: "https://other.example/jobs", text: "Next" },
        sourceUrl,
      ),
    ).toBe(false);
  });

  it("compresses repeatable actions into a durable semantic recipe", () => {
    const recipe: SourceBrowserAgentState["replaySteps"] = [];
    appendReplayStep(recipe, { kind: "scroll", repetitions: 1 });
    appendReplayStep(recipe, { kind: "scroll", repetitions: 1 });
    appendReplayStep(recipe, {
      kind: "click",
      repetitions: 1,
      label: "load more jobs",
    });
    expect(recipe).toEqual([
      { kind: "scroll", repetitions: 2 },
      { kind: "click", repetitions: 1, label: "load more jobs" },
    ]);
  });

  it("checkpoints browser-agent state with the source frontier", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "source-browser-agent-"));
    const inventory = new VacancySourceInventory(root, "candidate-1");
    const browserAgentState: SourceBrowserAgentState = {
      version: 1,
      replaySteps: [{ kind: "scroll", repetitions: 3 }],
      observedVacancyUrls: [`${sourceUrl}/jobs/one`],
      interactionsCompleted: 3,
      exhausted: false,
      lastObservedUrl: sourceUrl,
      lastActionAt: "2026-07-21T10:00:00.000Z",
    };
    await runVacancySource({
      browser: {} as Browser,
      codex: {} as CodexExecClient,
      cwd: process.cwd(),
      workspace: { candidateId: "candidate-1" } as JobSearchWorkspace,
      phase2Evidence: {} as Phase2EvidenceContext,
      inventory,
      source,
      targetCandidates: 1,
      maxPages: 1,
      expandBatch: async () => ({
        candidates: [
          {
            company: "Example",
            preliminaryFit: 60,
            job: {
              id: "one",
              title: "Engineer",
              jobUrl: `${sourceUrl}/jobs/one`,
              applyUrl: `${sourceUrl}/jobs/one`,
              sourceKind: "vacancy",
            },
          },
        ],
        nextUrl: sourceUrl,
        inspected: 1,
        browserAgentState,
      }),
    });

    expect((await inventory.list())[0].browserAgent).toEqual(browserAgentState);
  });

  it("defers a transient navigation failure without retrying it in a loop", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "source-browser-retry-"));
    const inventory = new VacancySourceInventory(root, "candidate-1");
    let expansionCalls = 0;
    await runVacancySource({
      browser: {} as Browser,
      codex: {} as CodexExecClient,
      cwd: process.cwd(),
      workspace: { candidateId: "candidate-1" } as JobSearchWorkspace,
      phase2Evidence: {} as Phase2EvidenceContext,
      inventory,
      source,
      targetCandidates: 2,
      maxPages: 3,
      expandBatch: async () => {
        expansionCalls += 1;
        return {
          candidates: [],
          nextUrl: sourceUrl,
          inspected: 0,
          navigationError: "temporary model timeout",
        };
      },
    });

    expect(expansionCalls).toBe(1);
    expect((await inventory.list())[0]).toMatchObject({
      hasMore: true,
      lastError: "temporary model timeout",
    });
  });
});
