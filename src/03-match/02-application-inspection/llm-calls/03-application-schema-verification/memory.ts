export const memory = {
  isolation: "fresh-process",
  reads: ["observed schema", "mapped fields"],
  writes: ["schema findings", "Codex run trace"],
} as const;
