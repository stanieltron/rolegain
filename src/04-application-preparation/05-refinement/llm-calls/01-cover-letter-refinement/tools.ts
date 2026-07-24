export const tools = {
  mode: "none",
  allowed: [],
  forbidden: ["shell", "filesystem", "web_search", "browser", "MCP"],
  rationale: "Refinement is bounded to supplied context.",
} as const;
