export interface ToolPolicy {
  mode: "none" | "web-search" | "browser-snapshot";
  allowed: readonly string[];
  forbidden: readonly string[];
  rationale: string;
}

export interface MemoryPolicy {
  isolation: "fresh-process" | "same-call-retry";
  reads: readonly string[];
  writes: readonly string[];
  checkpoint?: string;
}

export interface CommandPolicy {
  runtime: "codex-exec";
  role: string;
  modelEnvironment: string;
  defaultModel: string;
  sandbox: "readOnly" | "workspaceWrite";
  approvalPolicy: "never" | "untrusted" | "on-request";
  effort: "low" | "medium" | "high";
  timeoutMs: number;
  webSearch: "disabled" | "cached" | "live";
}

export interface AgentCallManifest {
  id: string;
  pipeline:
    | "01-evidence-ingestion"
    | "02-search"
    | "03-match"
    | "04-application-preparation";
  name: string;
  purpose: string;
  fanOut: "single" | "parallel-per-chunk" | "parallel-per-source" | "parallel-per-job";
  input: string;
  output: string;
  rolePrompt: string;
  tools: ToolPolicy;
  memory: MemoryPolicy;
  command: CommandPolicy;
  verification: string[];
}
