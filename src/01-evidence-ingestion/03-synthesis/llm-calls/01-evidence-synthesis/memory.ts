export const memory = {
  isolation: "fresh-process",
  reads: ["current profile", "reader outputs", "material unknowns"],
  writes: ["canonical synthesis JSON", "Codex run trace"],
} as const;
