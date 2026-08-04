import { createHash } from "node:crypto";

export interface WorkflowFailureAlert {
  runId: string;
  userId: string;
  userEmail?: string;
  workflowType: string;
  resourceId?: string;
  error: string;
  occurredAt: string;
}

export type WorkflowFailureNotifier = (
  alert: WorkflowFailureAlert,
) => Promise<void>;

export interface WorkflowErrorEmailOptions {
  apiKey?: string;
  to?: string;
  from?: string;
  adminUrl?: string;
}

const RESEND_EMAIL_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "Rolegain alerts <onboarding@resend.dev>";

export function createWorkflowFailureNotifier(
  options: WorkflowErrorEmailOptions,
  request: typeof fetch = fetch,
): WorkflowFailureNotifier {
  if (!options.apiKey || !options.to) return async () => undefined;

  return async (alert) => {
    const category = classifyWorkflowFailure(alert.error);
    const safeError = sanitizeWorkflowError(alert.error);
    const subject = `[Rolegain] ${category} in ${alert.workflowType}`;
    const details = [
      `Category: ${category}`,
      `Time: ${alert.occurredAt}`,
      `Workflow: ${alert.workflowType}`,
      `Run: ${alert.runId}`,
      `User ID: ${alert.userId}`,
      `User email: ${alert.userEmail || "unknown"}`,
      `Resource: ${alert.resourceId || "none"}`,
      "",
      "Sanitized error:",
      safeError,
      ...(options.adminUrl ? ["", `Admin: ${options.adminUrl}`] : []),
    ].join("\n");
    const body = JSON.stringify({
      from: options.from || DEFAULT_FROM,
      to: [options.to],
      subject,
      text: details,
      tags: [
        { name: "category", value: emailTagValue(category) },
        { name: "workflow", value: emailTagValue(alert.workflowType) },
      ],
    });
    const bodyHash = createHash("sha256").update(body).digest("hex").slice(0, 32);
    const response = await request(RESEND_EMAIL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `workflow-failed/${alert.runId}/${bodyHash}`,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      throw new Error(
        `Resend rejected workflow alert (${response.status}): ${responseText.slice(0, 300)}`,
      );
    }
  };
}

export function classifyWorkflowFailure(error: string) {
  const value = error.toLowerCase();
  if (/invalid refresh token|token[_ ]expired|log out and sign in|401 unauthorized/.test(value))
    return "codex_auth";
  if (/emaxconnsession|max clients|too many clients|connection pool/.test(value))
    return "database_capacity";
  if (/timeout|timed out|heartbeat|expired/.test(value)) return "timeout";
  if (/application|apply form|vacancy/.test(value)) return "application_flow";
  return "workflow_error";
}

export function sanitizeWorkflowError(error: string) {
  return error
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:re|sk|AIza)[-_A-Za-z0-9]{16,}\b/g, "[REDACTED_KEY]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_TOKEN]")
    .replace(/([?&](?:token|key|secret|password|code)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/("?(?:access_token|refresh_token|api_key|password|secret)"?\s*[:=]\s*)[^,}\s]+/gi, "$1[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2_000);
}

function emailTagValue(value: string) {
  return value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 256) || "unknown";
}
