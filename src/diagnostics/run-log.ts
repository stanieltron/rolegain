import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const pendingWrites = new Map<string, Promise<void>>();

export function diagnosticLogRoot() {
  const configured = process.env.ROLEGAIN_DIAGNOSTIC_LOG_ROOT?.trim();
  return configured ? path.resolve(configured) : undefined;
}

export async function initializeDiagnosticLog(
  metadata: Record<string, unknown>,
) {
  const root = diagnosticLogRoot();
  if (!root) return;
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "session.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
}

export function appendDiagnosticEvent(
  category: string,
  data: Record<string, unknown>,
) {
  const root = diagnosticLogRoot();
  if (!root) return Promise.resolve();
  const file = path.join(root, "diagnostic-events.jsonl");
  const line = `${JSON.stringify({
    timestamp: new Date().toISOString(),
    category,
    ...data,
  })}\n`;
  const previous = pendingWrites.get(file) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await mkdir(root, { recursive: true });
      await appendFile(file, line, "utf8");
    });
  pendingWrites.set(file, next);
  return next;
}
