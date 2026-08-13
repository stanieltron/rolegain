import { createHmac, timingSafeEqual } from "node:crypto";
import type { RuntimeConfiguration } from "../config/runtime.js";

const SESSION_VERSION = 1;
const SESSION_LIFETIME_MS = 30 * 60 * 1_000;

export const EMPLOYER_PROXY_PATH = "/__rolegain_employer_proxy";

export interface EmployerProxySession {
  version: 1;
  userId: string;
  applicationId: string;
  targetUrl: string;
  expiresAt: number;
}

export function employerProxySecret(configuration: RuntimeConfiguration) {
  return (
    configuration.supabaseServiceRoleKey ||
    configuration.adminSessionSecret ||
    "rolegain-local-employer-proxy"
  );
}

export function createEmployerProxySession(
  input: Omit<EmployerProxySession, "version" | "expiresAt"> & {
    expiresAt?: number;
  },
  secret: string,
) {
  const session: EmployerProxySession = {
    version: SESSION_VERSION,
    userId: input.userId,
    applicationId: input.applicationId,
    targetUrl: new URL(input.targetUrl).toString(),
    expiresAt: input.expiresAt ?? Date.now() + SESSION_LIFETIME_MS,
  };
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyEmployerProxySession(
  token: string,
  secret: string,
  now = Date.now(),
): EmployerProxySession | undefined {
  const [payload, suppliedSignature, extra] = token.split(".");
  if (!payload || !suppliedSignature || extra) return undefined;
  const expectedSignature = sign(payload, secret);
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Partial<EmployerProxySession>;
    if (
      parsed.version !== SESSION_VERSION ||
      typeof parsed.userId !== "string" ||
      !parsed.userId ||
      typeof parsed.applicationId !== "string" ||
      !parsed.applicationId ||
      typeof parsed.targetUrl !== "string" ||
      typeof parsed.expiresAt !== "number" ||
      parsed.expiresAt <= now
    )
      return undefined;
    const target = new URL(parsed.targetUrl);
    if (target.protocol !== "http:" && target.protocol !== "https:")
      return undefined;
    return parsed as EmployerProxySession;
  } catch {
    return undefined;
  }
}

export function employerProxyUrl(token: string, targetUrl: string) {
  const target = new URL(targetUrl);
  return `${EMPLOYER_PROXY_PATH}/${token}${target.pathname}${target.search}${target.hash}`;
}

export function employerProxyBase(token: string) {
  return `${EMPLOYER_PROXY_PATH}/${token}`;
}

function sign(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}
