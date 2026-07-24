export const memory = {
  isolation: "fresh-process",
  reads: ["target field", "application context"],
  writes: ["revised answer", "Codex run trace"],
} as const;
