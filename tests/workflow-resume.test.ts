import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JobSearchWorkspace } from "../src/contracts/job-search.js";
import { workflowBlocksEnqueue } from "../src/backend/workflows/workflow-queue.js";
import { JobSearchService } from "../src/backend/control-flow/service.js";
import {
  interruptedResumeControl,
  workflowIsActive,
} from "../src/server/job-search-routes.js";

function runningSearchWorkspace(): JobSearchWorkspace {
  return {
    intelligence: { status: "ready" },
    sources: [],
    searchProgress: {
      stage: "verifying",
      target: 5,
      found: 0,
    },
  } as unknown as JobSearchWorkspace;
}

describe("workflow stop and resume state", () => {
  it("does not let a cancellation-requested run block a replacement", () => {
    expect(
      workflowBlocksEnqueue({
        status: "running",
        cancellation_requested_at: new Date(),
      }),
    ).toBe(false);
    expect(
      workflowBlocksEnqueue({
        status: "running",
        cancellation_requested_at: null,
      }),
    ).toBe(true);
  });

  it("treats cancellation-requested workflows as inactive", () => {
    expect(
      workflowIsActive({
        status: "running",
        cancellationRequestedAt: new Date().toISOString(),
      }),
    ).toBe(false);
    expect(workflowIsActive({ status: "queued" })).toBe(true);
  });

  it("reconstructs a resumable search when saved progress has no live worker", () => {
    const control = interruptedResumeControl(runningSearchWorkspace(), {
      type: "prepare",
      status: "running",
      cancellationRequestedAt: new Date().toISOString(),
    });
    expect(control).toMatchObject({
      state: "stopped",
      resumeSearch: "prepare",
    });
  });

  it("preserves the search-ready resume mode", () => {
    const control = interruptedResumeControl(runningSearchWorkspace(), {
      type: "prepare-search-ready",
      status: "cancelled",
    });
    expect(control?.resumeSearch).toBe("prepare_search_ready");
  });

  it("does not offer resume while a workflow is genuinely queued or running", () => {
    expect(
      interruptedResumeControl(runningSearchWorkspace(), {
        type: "prepare",
        status: "running",
      }),
    ).toBeUndefined();
  });

  it("continues stale saved progress when the server supplies a recovery plan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-recover-workflow-"));
    const service = new JobSearchService(root);
    await service.initialize();
    await service.markWorkflowQueued("prepare");

    const resumed = await service.continueBackgroundWork(
      "candidate-1",
      false,
      { state: "stopped", resumeSearch: "prepare" },
    );

    expect(resumed.backgroundExecution).toEqual({ state: "running" });
    expect(resumed.searchProgress).toMatchObject({
      stage: "looking",
      activity: "Continuing the stopped workflow from saved progress.",
    });
  });
});
