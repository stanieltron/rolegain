import { enableV2PipelineVersions } from "./enable-v2.js";

enableV2PipelineVersions();
await import("../src/server/index.js");
export {};
