export const tools = {
  mode: "browser-snapshot",
  allowed: [],
  forbidden: [
    "submit",
    "authentication",
    "registration",
    "consent",
    "shell",
    "filesystem",
    "web_search",
    "browser",
    "MCP",
  ],
  rationale:
    "The model selects one action from an immutable observation; the backend validates and actuates it separately.",
} as const;
