export const SUPPORTED_CODEX_VERSION = "0.139.0";

export interface RpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface CodexTurnResult {
  threadId: string;
  turnId: string;
  status: "completed" | "interrupted" | "failed";
  finalText: string;
  items: Array<Record<string, unknown>>;
  error?: string;
}

export interface CodexThread {
  id: string;
  modelProvider?: string;
}

export interface CodexRuntimeInfo {
  available: boolean;
  binary: string;
  version: string;
  compatible: boolean;
  authenticated: boolean;
  authMode?: string;
  model?: string;
  models: Array<{ id: string; displayName: string; isDefault?: boolean }>;
}
