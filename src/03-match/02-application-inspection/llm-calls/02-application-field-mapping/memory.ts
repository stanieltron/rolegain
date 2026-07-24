export const memory = {
  isolation: "fresh-process",
  reads: ["captured employer schema", "confirmed candidate facts"],
  writes: ["field mappings", "Codex run trace"],
} as const;
