import { describe, expect, it } from "vitest";
import { BoundedExecutor } from "../src/03-match/orchestration/bounded-executor.js";
import {
  runBoundedStreamingPipeline,
  runBoundedTwoStageStreamingPipeline,
} from "../src/03-match/orchestration/streaming-pipeline.js";
import { reverseVerifyOneMatch } from "../src/03-match/shared/01-requirement-matching/reverse-verification/index.js";
import { runOneSearch } from "../src/02-search/v1/01-discovery/run-one-search.js";
import { validateOneVacancy } from "../src/02-search/v1/03-vacancy-validation/validate-one/index.js";
import { matchOneOpportunity } from "../src/03-match/shared/01-requirement-matching/match-one/index.js";
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

  it("checkpoints each completed match before the full search finishes", async () => {
    const checkpoints: string[] = [];
    await runBoundedStreamingPipeline({
      concurrency: 2,
      key: (job: { id: string }) => job.id,
      produce: async (emit) => {
        emit({ id: "a" });
        emit({ id: "b" });
        return undefined;
      },
      consume: async (job) => `matched-${job.id}`,
      onCompleted: async (_job, result) => {
        checkpoints.push(result);
      },
    });

    expect(checkpoints.sort()).toEqual(["matched-a", "matched-b"]);
  });

  it("starts matching each prevalidated vacancy without waiting for the prevalidation batch", async () => {
    const events: string[] = [];
    let releaseSecondPrevalidation!: () => void;
    const holdSecondPrevalidation = new Promise<void>((resolve) => {
      releaseSecondPrevalidation = resolve;
    });

    const run = await runBoundedTwoStageStreamingPipeline({
      firstConcurrency: 2,
      secondConcurrency: 1,
      key: (job: { id: string }) => job.id,
      produce: async (emit) => {
        emit({ id: "a" });
        emit({ id: "b" });
        return "search-complete";
      },
      first: async (job) => {
        events.push(`prevalidation-start:${job.id}`);
        if (job.id === "b") await holdSecondPrevalidation;
        events.push(`prevalidation-end:${job.id}`);
        return job;
      },
      second: async (job) => {
        events.push(`match:${job.id}`);
        if (job.id === "a") releaseSecondPrevalidation();
        return `matched-${job.id}`;
      },
    });

    expect(events.indexOf("match:a")).toBeLessThan(
      events.indexOf("prevalidation-end:b"),
    );
    expect(run).toEqual({
      producerResult: "search-complete",
      results: ["matched-a", "matched-b"],
    });
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
