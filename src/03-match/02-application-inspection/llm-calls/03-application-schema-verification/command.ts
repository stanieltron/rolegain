export const command = {
  runtime: "codex-exec",
  role: "application-schema-verifier",
  modelEnvironment: "ROLEGAIN_FAST_MODEL",
  defaultModel: "gpt-5.6-luna",
  sandbox: "readOnly",
  approvalPolicy: "never",
  effort: "low",
  timeoutMs: 90_000,
  webSearch: "disabled",
} as const;
