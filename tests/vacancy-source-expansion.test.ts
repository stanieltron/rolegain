import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import type { CodexExecClient } from "../src/codex-runtime/client.js";
import type { JobSearchWorkspace } from "../src/contracts/job-search.js";
import {
  classifySearchLead,
  type VacancySourceCheckpoint,
} from "../src/02-search/v1/02-vacancy-source-expansion/contracts.js";
import {
  VacancySourceInventory,
  checkpointAsCandidate,
  checkpointNeedsHeadRefresh,
} from "../src/02-search/v1/02-vacancy-source-expansion/inventory/index.js";
import { runVacancySource } from "../src/02-search/v1/02-vacancy-source-expansion/run/index.js";
import type { Phase2EvidenceContext } from "../src/search-match-shared/evidence-context.js";
import type { LiveCandidate } from "../src/search-match-shared/types.js";

const source: LiveCandidate = {
  company: "Example Careers",
  preliminaryFit: 0,
  job: {
    id: "source-1",
    title: "Example Careers",
    jobUrl: "https://jobs.example.test/careers",
    applyUrl: "https://jobs.example.test/careers",
    sourceKind: "career_page",
    sourceClass: "employer_career",
    discoveryQuery: "example careers",
  },
};

const child = (id: string): LiveCandidate => ({
  company: "Example",
  preliminaryFit: 60,
  job: {
    id,
    title: `Engineer ${id}`,
    jobUrl: `https://jobs.example.test/jobs/${id}`,
    applyUrl: `https://jobs.example.test/jobs/${id}`,
    sourceKind: "vacancy",
  },
});

describe("persistent vacancy-source expansion", () => {
  it("classifies direct vacancies and expandable searches separately", () => {
    expect(classifySearchLead(child("one")).kind).toBe("vacancy");
    expect(classifySearchLead(source).kind).toBe("vacancy_search");
    expect(
      classifySearchLead({
        ...child("legacy"),
        job: { ...child("legacy").job, sourceKind: undefined },
      }).kind,
    ).toBe("vacancy");
    expect(
      classifySearchLead({
        ...child("generic-list"),
        job: {
          ...child("generic-list").job,
          title: "DeFi Jobs Listing",
          jobUrl: "https://example.test/jobs/defi?page=1",
          applyUrl: "https://example.test/jobs/defi?page=1",
          sourceKind: "vacancy",
        },
      }).kind,
    ).toBe("vacancy_search");
  });

  it("persists and reloads a source independently of one search run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vacancy-source-inventory-"));
    const inventory = new VacancySourceInventory(root, "candidate-1");
    const registered = await inventory.register(source);
    registered.cursorUrl = "https://jobs.example.test/careers?page=2";
    registered.pagesInspected = 1;
    registered.seenVacancyUrls = [child("one").job.jobUrl];
    await inventory.save(registered);

    const [reloaded] = await new VacancySourceInventory(
      root,
      "candidate-1",
    ).list();
    expect(reloaded).toMatchObject({
      cursorUrl: "https://jobs.example.test/careers?page=2",
      pagesInspected: 1,
      hasMore: true,
    });
    expect(checkpointAsCandidate(reloaded).job.sourceKind).toBe("job_list");
  });

  it("attaches the marketplace parent to every emitted concrete vacancy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vacancy-source-parent-"));
    const inventory = new VacancySourceInventory(root, "candidate-1");
    const emitted = await runVacancySource({
      browser: {} as Browser,
      codex: {} as CodexExecClient,
      cwd: process.cwd(),
      workspace: { candidateId: "candidate-1" } as JobSearchWorkspace,
      phase2Evidence: {} as Phase2EvidenceContext,
      inventory,
      source,
      maxPages: 1,
      targetCandidates: 1,
      expandBatch: async () => ({
        candidates: [child("nested")],
        inspected: 1,
      }),
    });
    expect(emitted[0].job.sourceGroup).toMatchObject({
      name: "Example Careers",
      url: "https://jobs.example.test/careers",
      sourceClass: "employer_career",
    });
  });

  it("continues the saved frontier on the next run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vacancy-source-resume-"));
    const inventory = new VacancySourceInventory(root, "candidate-1");
    const visited: string[] = [];
    const common = {
      browser: {} as Browser,
      codex: {} as CodexExecClient,
      cwd: process.cwd(),
      workspace: { candidateId: "candidate-1" } as JobSearchWorkspace,
      phase2Evidence: {} as Phase2EvidenceContext,
      inventory,
      source,
      maxPages: 1,
      targetCandidates: 2,
      expandBatch: async (input: { pageUrl: string }) => {
        visited.push(input.pageUrl);
        if (input.pageUrl.endsWith("careers"))
          return {
            candidates: [child("one"), child("two")],
            nextUrl: "https://jobs.example.test/careers?page=2",
            inspected: 20,
          };
        return {
          candidates: [child("three"), child("four")],
          inspected: 20,
        };
      },
    };

    expect((await runVacancySource(common)).map((item) => item.job.id)).toEqual([
      "one",
      "two",
    ]);
    expect(
      (await inventory.list())[0],
    ).toMatchObject({
      cursorUrl: "https://jobs.example.test/careers?page=2",
      hasMore: true,
      vacanciesEmitted: 2,
    });

    expect((await runVacancySource(common)).map((item) => item.job.id)).toEqual([
      "three",
      "four",
    ]);
    expect(visited).toEqual([
      "https://jobs.example.test/careers",
      "https://jobs.example.test/careers?page=2",
    ]);
    expect((await inventory.list())[0]).toMatchObject({
      hasMore: false,
      vacanciesEmitted: 4,
    });
  });

  it("refreshes a source head after its freshness window", () => {
    const checkpoint = {
      lastHeadRefreshAt: "2026-01-01T00:00:00.000Z",
    } as VacancySourceCheckpoint;
    expect(
      checkpointNeedsHeadRefresh(checkpoint, Date.parse("2026-02-01T00:00:00Z")),
    ).toBe(true);
  });

  it("prioritizes a stale head refresh over the saved backlog", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vacancy-source-refresh-"));
    const inventory = new VacancySourceInventory(root, "candidate-1");
    const checkpoint = await inventory.register(source);
    checkpoint.pagesInspected = 4;
    checkpoint.cursorUrl = "https://jobs.example.test/careers?page=5";
    checkpoint.pendingVacancies = [child("older")];
    checkpoint.lastHeadRefreshAt = "2026-01-01T00:00:00.000Z";
    await inventory.save(checkpoint);

    const emitted = await runVacancySource({
      browser: {} as Browser,
      codex: {} as CodexExecClient,
      cwd: process.cwd(),
      workspace: { candidateId: "candidate-1" } as JobSearchWorkspace,
      phase2Evidence: {} as Phase2EvidenceContext,
      inventory,
      source,
      targetCandidates: 1,
      maxPages: 1,
      expandBatch: async ({ pageUrl }) => {
        expect(pageUrl).toBe(source.job.jobUrl);
        return { candidates: [child("fresh")], inspected: 20 };
      },
    });

    expect(emitted.map((item) => item.job.id)).toEqual(["fresh"]);
    expect((await inventory.list())[0].pendingVacancies.map((item) => item.job.id))
      .toEqual(["older"]);
  });

  it("banks extracted vacancies that exceed the current run target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vacancy-source-pending-"));
    const inventory = new VacancySourceInventory(root, "candidate-1");
    let expansionCalls = 0;
    const common = {
      browser: {} as Browser,
      codex: {} as CodexExecClient,
      cwd: process.cwd(),
      workspace: { candidateId: "candidate-1" } as JobSearchWorkspace,
      phase2Evidence: {} as Phase2EvidenceContext,
      inventory,
      source,
      maxPages: 1,
      expandBatch: async () => {
        expansionCalls += 1;
        return {
          candidates: [child("one"), child("two"), child("three")],
          nextUrl: "https://jobs.example.test/careers?page=2",
          inspected: 20,
        };
      },
    };

    expect(
      (await runVacancySource({ ...common, targetCandidates: 1 })).map(
        (item) => item.job.id,
      ),
    ).toEqual(["one"]);
    expect((await inventory.list())[0].pendingVacancies).toHaveLength(2);

    expect(
      (await runVacancySource({ ...common, targetCandidates: 2 })).map(
        (item) => item.job.id,
      ),
    ).toEqual(["two", "three"]);
    expect(expansionCalls).toBe(1);
    expect((await inventory.list())[0]).toMatchObject({
      cursorUrl: "https://jobs.example.test/careers?page=2",
      hasMore: true,
      pendingVacancies: [],
    });
  });
});
