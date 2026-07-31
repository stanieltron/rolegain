import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { SUPPORTED_CODEX_VERSION } from "../src/codex-runtime/protocol.js";

try {
  loadEnvFile(".env");
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
    throw error;
}

const projectRoot = process.cwd();
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const sessionRoot = path.resolve(
  process.env.ROLEGAIN_DIAGNOSTIC_SESSION_ROOT ||
    path.join(projectRoot, ".local-run", "diagnostic", timestamp),
);
const apiPort = Number(process.env.ROLEGAIN_DIAGNOSTIC_API_PORT || 4327);
const uiPort = Number(process.env.ROLEGAIN_DIAGNOSTIC_UI_PORT || 4328);
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const uiOrigin = `http://127.0.0.1:${uiPort}`;

process.env.ROLEGAIN_AUTH_MODE = "local";
process.env.ROLEGAIN_LLM_TRANSPORT = "codex";
process.env.ROLEGAIN_PROCESS_JOBS = "true";
process.env.ROLEGAIN_OBJECT_STORAGE = "disabled";
process.env.ROLEGAIN_MODEL ||= "gpt-5.6-terra";
process.env.ROLEGAIN_FAST_MODEL ||= "gpt-5.6-luna";
process.env.ROLEGAIN_SEARCH_MODEL ||= "gpt-5.6-luna";
process.env.ROLEGAIN_COVER_MODEL ||= "gpt-5.6-terra";
process.env.ROLEGAIN_PUBLIC_ORIGIN = uiOrigin;
process.env.ROLEGAIN_DIAGNOSTIC_LOG_ROOT = sessionRoot;
process.env.ROLEGAIN_LLM_RUN_ROOT = path.join(sessionRoot, "llm-calls");
process.env.PORT = String(apiPort);
process.env.HOST = "127.0.0.1";

// This launch is deliberately isolated from Supabase and Railway.
delete process.env.DATABASE_URL;
delete process.env.ROLEGAIN_TRANSACTION_DATABASE_URL;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_PUBLISHABLE_KEY;
delete process.env.SUPABASE_ANON_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

await mkdir(sessionRoot, { recursive: true });

const { initializeDiagnosticLog, appendDiagnosticEvent } = await import(
  "../src/diagnostics/run-log.js"
);
const { createRolegainApp } = await import("../src/server/app.js");

await initializeDiagnosticLog({
  mode: "local-codex-diagnostic",
  startedAt: new Date().toISOString(),
  sessionRoot,
  dataRoot: path.join(sessionRoot, "data"),
  llmRunRoot: process.env.ROLEGAIN_LLM_RUN_ROOT,
  apiOrigin,
  uiOrigin,
  model: process.env.ROLEGAIN_MODEL || "gpt-5.4",
  fastModel: process.env.ROLEGAIN_FAST_MODEL || "gpt-5.4-mini",
});

const app = await createRolegainApp({
  rootDir: projectRoot,
  dataRoot: path.join(sessionRoot, "data"),
});
const port = await app.start(apiPort);
const runtime = await app.codex.start();
await appendDiagnosticEvent("diagnostic-started", {
  port,
  codex: {
    binary: runtime.binary,
    version: runtime.version,
    compatible: runtime.compatible,
    authenticated: runtime.authenticated,
    authMode: runtime.authMode,
    model: runtime.model,
  },
});
if (!runtime.authenticated) {
  await app.close();
  throw new Error(
    "Local Codex is not authenticated. Run `codex login` and start the diagnostic mode again.",
  );
}
if (!runtime.compatible) {
  await app.close();
  throw new Error(
    `Local Codex ${runtime.version} is not the tested ${SUPPORTED_CODEX_VERSION} release. ` +
      `Run \`npm install -g @openai/codex@${SUPPORTED_CODEX_VERSION}\` and start diagnostic mode again.`,
  );
}

const viteEntry = path.join(projectRoot, "node_modules", "vite", "bin", "vite.js");
const ui = spawn(
  process.execPath,
  [
    viteEntry,
    "--host",
    "127.0.0.1",
    "--port",
    String(uiPort),
    "--strictPort",
  ],
  {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ROLEGAIN_LOCAL_API_ORIGIN: apiOrigin,
      VITE_ROLEGAIN_AUTH_MODE: "local",
    },
  },
);

pipeChild(ui, "vite-stdout");
pipeChild(ui, "vite-stderr", true);

console.log(`RolegAIn diagnostic UI: ${uiOrigin}`);
console.log(`Diagnostic session: ${sessionRoot}`);
console.log(`LLM call traces: ${process.env.ROLEGAIN_LLM_RUN_ROOT}`);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  await appendDiagnosticEvent("diagnostic-stopping", { signal });
  await stopChild(ui);
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
ui.once("exit", (code, signal) => {
  if (!shuttingDown) {
    console.error(`Diagnostic UI exited (${code ?? signal ?? "unknown"})`);
    void shutdown("ui-exit");
  }
});
await new Promise(() => undefined);

function pipeChild(
  child: ChildProcess,
  category: string,
  stderr = false,
) {
  const stream = stderr ? child.stderr : child.stdout;
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk: string) => {
    const text = String(chunk);
    (stderr ? process.stderr : process.stdout).write(text);
    for (const line of text.split(/\r?\n/).filter(Boolean))
      void appendDiagnosticEvent(category, { line });
  });
}

async function stopChild(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn(
        "taskkill.exe",
        ["/pid", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      killer.once("exit", () => resolve());
      killer.once("error", () => resolve());
    });
  } else child.kill("SIGTERM");
}
