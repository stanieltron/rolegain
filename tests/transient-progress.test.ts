import { describe, expect, it, vi } from "vitest";
import { InMemoryTransientWorkflowProgressBus } from "../src/backend/workflows/transient-progress.js";

describe("transient workflow progress", () => {
  it("delivers factual events only to the active user without persistence", async () => {
    const bus = new InMemoryTransientWorkflowProgressBus();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = await bus.subscribe("candidate-1", first);
    await bus.subscribe("candidate-2", second);

    await bus.publish("candidate-1", {
      message: "Search wave 1 classified 20 captured pages.",
      phase: "validation",
      state: "running",
    });

    expect(first).toHaveBeenCalledWith(expect.objectContaining({
      userId: "candidate-1",
      message: "Search wave 1 classified 20 captured pages.",
      phase: "validation",
      state: "running",
    }));
    expect(second).not.toHaveBeenCalled();

    unsubscribeFirst();
    await bus.publish("candidate-1", { message: "No longer observed." });
    expect(first).toHaveBeenCalledTimes(1);
    await bus.close();
  });

  it("bounds transient payloads before cross-process publication", async () => {
    const bus = new InMemoryTransientWorkflowProgressBus();
    const listener = vi.fn();
    await bus.subscribe("candidate-1", listener);
    await bus.publish("candidate-1", { message: "x".repeat(3_000) });

    expect(listener.mock.calls[0][0].message).toHaveLength(2_000);
  });
});
