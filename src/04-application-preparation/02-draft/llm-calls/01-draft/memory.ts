export const memory = {
  isolation: "fresh-process",
  reads: ["application context", "candidate evidence"],
  writes: ["application drafts", "Codex run trace"],
} as const;
