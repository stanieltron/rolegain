export const tools = {
  mode: "web-search",
  allowed: ["web_search"],
  forbidden: ["shell", "filesystem", "browser", "MCP"],
  rationale:
    "Application-stage company research needs current public facts but no access to candidate files or application forms.",
} as const;
