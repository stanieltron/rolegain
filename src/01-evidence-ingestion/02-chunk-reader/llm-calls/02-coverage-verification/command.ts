export const command = {
  runtime: "codex-exec",
  role: "candidate-source-coverage-verifier",
  modelEnvironment: "ROLEGAIN_FAST_MODEL",
  defaultModel: "gpt-5.4-mini",
  threadSandbox: "read-only",
  sandbox: "readOnly",
  approvalPolicy: "never",
  effort: "medium",
  timeoutMs: 15 * 60_000,
  webSearch: "disabled",
} as const;
