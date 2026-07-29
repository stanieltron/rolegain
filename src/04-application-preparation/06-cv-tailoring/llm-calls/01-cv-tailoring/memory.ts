export const memory = {
  isolation: "fresh-process",
  reads: ["original CV", "one grounded application context"],
  writes: ["tailored CV", "Codex run trace"],
} as const;
