export const memory = {
  isolation: "fresh-process",
  reads: ["immutable source chunk", "source id/version", "stable locator"],
  writes: ["per-chunk JSON checkpoint", "Codex run trace"],
    checkpoint: "Non-CV only: data/job-search/analysis-checkpoints/<candidate>/<prompt-version-model>/<source-version>/chunk-N-of-M.json",
} as const;
