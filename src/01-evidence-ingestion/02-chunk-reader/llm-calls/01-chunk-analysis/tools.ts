export const tools = {
  mode: "none",
  allowed: [],
  forbidden: ["shell", "filesystem", "web_search", "browser", "MCP"],
  rationale: "The complete bounded source chunk is in the prompt; external context would break provenance.",
} as const;
