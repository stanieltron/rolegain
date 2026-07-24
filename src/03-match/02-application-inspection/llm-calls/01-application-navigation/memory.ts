export const memory = {
  isolation: "same-call-retry",
  reads: ["current page observation"],
  writes: ["bounded navigation action", "Codex run trace"],
} as const;
