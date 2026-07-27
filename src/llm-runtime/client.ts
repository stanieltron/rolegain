import { OpenAiCompatibleClient } from "../api-runtime/client.js";
import {
  CodexExecClient,
} from "../codex-runtime/client.js";
import type { LlmConfigurationSet } from "../codex-runtime/llm-call-config.js";

export type LlmTransport = "api" | "codex";

export function configuredLlmTransport(): LlmTransport {
  const value = (process.env.ROLEGAIN_LLM_TRANSPORT || "codex")
    .trim()
    .toLowerCase();
  if (value === "api" || value === "codex") return value;
  throw new Error(
    `Unsupported ROLEGAIN_LLM_TRANSPORT "${value}"; expected "codex" or "api"`,
  );
}

/**
 * Selects execution transport only. The same call manifests, skills, schemas,
 * prompts, result gateways and flow orchestration are used by both transports.
 */
export function createLlmClient(
  projectRoot = process.cwd(),
  configuration?: LlmConfigurationSet,
): CodexExecClient {
  return configuredLlmTransport() === "api"
    ? new OpenAiCompatibleClient(projectRoot, configuration)
    : new CodexExecClient(projectRoot, configuration);
}
