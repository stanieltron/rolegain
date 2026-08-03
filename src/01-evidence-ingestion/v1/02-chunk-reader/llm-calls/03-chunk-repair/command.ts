export const command = {
  runtime: "codex-exec",
  role: "candidate-source-repairer",
  modelEnvironment: "ROLEGAIN_FAST_MODEL",
  defaultModel: "gpt-5.6-luna",
  threadSandbox: "read-only",
  sandbox: "readOnly",
  approvalPolicy: "never",
  effort: "low",
  timeoutMs: 15 * 60_000,
  webSearch: "disabled",
} as const;
