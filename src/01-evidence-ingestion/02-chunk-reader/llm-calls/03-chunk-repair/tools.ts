export const tools = {
  mode: "none",
  allowed: [],
  forbidden: ["shell", "filesystem", "web_search", "browser", "MCP"],
  rationale: "Repair is limited to the source, extraction, and findings supplied in the prompt.",
} as const;
