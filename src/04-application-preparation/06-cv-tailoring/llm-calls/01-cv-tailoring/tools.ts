export const tools = {
  mode: "none",
  allowed: [],
  forbidden: ["shell", "filesystem", "web_search", "browser", "MCP"],
  rationale:
    "CV tailoring is bounded to the supplied original CV and application context.",
} as const;
