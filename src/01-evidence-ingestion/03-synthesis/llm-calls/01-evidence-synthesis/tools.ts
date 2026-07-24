export const tools = {
  mode: "none",
  allowed: [],
  forbidden: ["shell", "filesystem", "web_search", "browser", "MCP"],
  rationale: "Synthesis must be a pure reduction over persisted reader outputs.",
} as const;
