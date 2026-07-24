export const command = {
  runtime: "codex-exec",
  role: "application-field-interpreter",
  modelEnvironment: "ROLEGAIN_FAST_MODEL",
  defaultModel: "gpt-5.4-mini",
  sandbox: "readOnly",
  approvalPolicy: "never",
  effort: "low",
  timeoutMs: 90_000,
  webSearch: "disabled",
} as const;
