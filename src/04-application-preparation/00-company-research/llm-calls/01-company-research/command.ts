export const command = {
  runtime: "codex-exec",
  role: "application-company-researcher",
  modelEnvironment: "ROLEGAIN_SEARCH_MODEL",
  defaultModel: "gpt-5.6-luna",
  sandbox: "readOnly",
  approvalPolicy: "never",
  effort: "low",
  timeoutMs: 3 * 60_000,
  webSearch: "live",
} as const;
