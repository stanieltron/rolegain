export const memory = {
  isolation: "fresh-process",
  reads: ["failed drafts", "verifier findings"],
  writes: ["repaired drafts", "Codex run trace"],
} as const;
