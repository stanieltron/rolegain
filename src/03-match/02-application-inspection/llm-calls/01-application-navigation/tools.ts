export const tools = {
  mode: "browser-snapshot",
  allowed: [],
  forbidden: [
    "submit",
    "authentication",
    "consent",
    "shell",
    "filesystem",
    "web_search",
    "browser",
    "MCP",
  ],
  rationale:
    "The call only selects an action; the backend separately validates and executes it.",
} as const;
