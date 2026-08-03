export const tools = {
  mode: "none",
  allowed: [],
  forbidden: ["shell", "filesystem", "web_search", "browser", "MCP"],
  rationale: "Coverage is judged only against the source chunk and proposed extraction supplied in the prompt.",
} as const;
