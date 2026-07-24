export const memory = {
  isolation: "fresh-process",
  reads: ["immutable source chunk", "normalized reader extraction"],
  writes: ["coverage decision", "Codex run trace"],
} as const;
