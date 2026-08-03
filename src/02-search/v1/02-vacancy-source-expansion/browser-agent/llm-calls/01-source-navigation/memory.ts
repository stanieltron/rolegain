export const memory = {
  isolation: "same-call-retry",
  reads: ["current source-page observation", "bounded progress counters"],
  writes: ["bounded navigation action", "Codex run trace"],
  checkpoint: "candidate vacancy-source browser-agent state",
} as const;
