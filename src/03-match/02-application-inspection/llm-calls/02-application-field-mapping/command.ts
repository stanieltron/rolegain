export const command = {
  runtime: "codex-exec",
  role: "application-browser-form-reader",
  modelEnvironment: "ROLEGAIN_MODEL",
  defaultModel: "runtime default",
  sandbox: "readOnly",
  approvalPolicy: "never",
  effort: "medium",
  timeoutMs: 180_000,
  webSearch: "disabled",
} as const;
