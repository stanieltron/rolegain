export const command = {
  runtime: "codex-exec",
  role: "application-cv-tailor",
  modelEnvironment: "ROLEGAIN_COVER_MODEL",
  defaultModel: "runtime default",
  sandbox: "readOnly",
  approvalPolicy: "never",
  effort: "medium",
  timeoutMs: 4 * 60_000,
  webSearch: "disabled",
} as const;
