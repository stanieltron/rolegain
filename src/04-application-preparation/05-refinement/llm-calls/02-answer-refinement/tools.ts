export const tools = {
  mode: "none",
  allowed: [],
  forbidden: ["shell", "filesystem", "web_search", "browser", "MCP"],
  rationale: "The answer must remain inside the supplied evidence.",
} as const;
