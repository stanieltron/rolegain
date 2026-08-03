import { describe, expect, it } from "vitest";
import { enableV2PipelineVersions } from "../scripts/enable-v2.js";
import { runtimeConfiguration } from "../src/config/runtime.js";

describe("full v2 launcher", () => {
  it("enables evidence, search, and matching v2 together", () => {
    const environment: NodeJS.ProcessEnv = {};
    enableV2PipelineVersions(environment);
    expect(runtimeConfiguration(environment)).toMatchObject({
      evidenceIngestionVersion: "v2",
      searchVersion: "v2",
      matchVersion: "v2",
    });
  });
});
