export const memory = {
  isolation: "fresh-process",
  reads: ["application context", "generated drafts", "code findings"],
  writes: ["verification verdicts", "Codex run trace"],
} as const;
