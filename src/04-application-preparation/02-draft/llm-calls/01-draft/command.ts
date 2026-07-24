export const command = {
  runtime: "codex-exec",
  role: "cover-letter-writer",
  modelEnvironment: "ROLEGAIN_COVER_MODEL",
  defaultModel: "runtime default",
  sandbox: "readOnly",
  approvalPolicy: "never",
  effort: "low",
  timeoutMs: 4 * 60_000,
  webSearch: "disabled",
} as const;
