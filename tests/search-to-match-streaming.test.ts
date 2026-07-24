import { describe, expect, it } from "vitest";
import { BoundedExecutor } from "../src/03-match/orchestration/bounded-executor.js";
import { runBoundedStreamingPipeline } from "../src/03-match/orchestration/streaming-pipeline.js";
import { reverseVerifyOneMatch } from "../src/03-match/01-requirement-matching/reverse-verification/index.js";
import { runOneSearch } from "../src/02-search/01-discovery/run-one-search.js";
import { validateOneVacancy } from "../src/02-search/03-vacancy-validation/validate-one/index.js";
import { matchOneOpportunity } from "../src/03-match/01-requirement-matching/match-one/index.js";
import type { CodexExecClient } from "../src/codex-runtime/client.js";
import type { JobOpportunity } from "../src/contracts/job-search.js";

describe("streaming search and match orchestration", () => {
  it("starts consuming a validated vacancy before discovery has completed", async () => {
    let producerFinished = false;
    let consumedWhileProducing = false;
    let releaseStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });

    const run = await runBoundedStreamingPipeline({
      concurrency: 2,
      key: (job: { id: string }) => job.id,
      produce: async (emit) => {
        emit({ id: "job-a" });
        await started;
        emit({ id: "job-b" });
        producerFinished = true;
        return "search-complete";
      },
      consume: async (job) => {
        consumedWhileProducing ||= !producerFinished;
        releaseStarted();
        return `matched-${job.id}`;
      },
    });

    expect(consumedWhileProducing).toBe(true);
    expect(run.producerResult).toBe("search-complete");
    expect(run.results).toEqual(["matched-job-a", "matched-job-b"]);
  });

  it("bounds active workers and ignores duplicate vacancy identities", async () => {
    let active = 0;
    let maximumActive = 0;
    const run = await runBoundedStreamingPipeline({
      concurrency: 2,
      key: (job: { id: string }) => job.id,
      produce: async (emit) => {
        for (const id of ["a", "b", "a", "c", "d"]) emit({ id });
        return undefined;
      },
      consume: async (job) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return job.id;
      },
    });

    expect(maximumActive).toBe(2);
    expect(run.results).toEqual(["a", "b", "c", "d"]);
  });

  it("releases executor capacity when a task fails", async () => {
    const executor = new BoundedExecutor(1);
    const first = executor.run(async () => {
      throw new Error("expected failure");
    });
    const second = executor.run(async () => "continued");

    await expect(first).rejects.toThrow("expected failure");
    await expect(second).resolves.toBe("continued");
  });

  it("publishes directly callable component boundaries", () => {
    expect(runOneSearch).toBeTypeOf("function");
    expect(validateOneVacancy).toBeTypeOf("function");
    expect(matchOneOpportunity).toBeTypeOf("function");
    expect(reverseVerifyOneMatch).toBeTypeOf("function");
  });

  it("can reverse-verify one supplied match without running search or matching", async () => {
    let callId = "";
    const codex = {
      async startThread(input: { callId?: string }) {
        callId = input.callId || "";
        return { id: "verification-thread" };
      },
      async runTurn() {
        return {
          finalText: JSON.stringify({
            jobId: "job-1",
            verdict: "pass",
            findings: [],
            repairInstructions: [],
            inflationFlags: [],
            feasibilityFlags: [],
            statusConfidence: 0.9,
            decision: "accepted",
            rationale: "The missing row makes no unsupported claim.",
          }),
        };
      },
    } as unknown as CodexExecClient;
    const opportunity = {
      id: "job-1",
      company: "Example",
      title: "Engineer",
      location: "Remote",
      workplace: "Remote",
      compensation: "Not disclosed",
      sourceUrl: "https://example.test/jobs/1",
      applyUrl: "https://example.test/jobs/1/apply",
      capturedAt: "2026-07-21",
      fit: 0,
      summary: "Requirements: TypeScript experience.",
      description: "Requirements: TypeScript experience.",
      requirements: [],
      requirementMatches: [],
      strengths: [],
      gaps: [],
    } satisfies JobOpportunity;

    const result = await reverseVerifyOneMatch({
      codex,
      cwd: process.cwd(),
      sourceLedger: [],
      opportunity,
      assessment: {
        jobId: opportunity.id,
        requirements: [
          {
            kind: "required",
            category: "mandatory",
            requirement: "TypeScript experience",
            status: "missing",
            matchClass: "unsupported",
            explanation: "No evidence was supplied.",
            evidence: [],
          },
        ],
      },
    });

    expect(callId).toBe("match.verification");
    expect(result).toMatchObject({ jobId: "job-1", verdict: "pass" });
  });
});
