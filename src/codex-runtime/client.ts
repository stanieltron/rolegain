import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import { discoverCodexBinary, getCodexVersion } from "./discover.js";
import {
  SUPPORTED_CODEX_VERSION,
  type CodexRuntimeInfo,
  type CodexThread,
  type CodexTurnResult,
  type RpcRequest,
} from "./protocol.js";
import {
  evaluateResultGateway,
  ResultGatewayError,
} from "./result-gateway.js";
import { LLM_CALL_SKILLS, skillForLlmCall } from "./skill-registry.js";
import {
  materializeSkillOverride,
  resolveLlmCallConfig,
  serializableResolvedConfig,
  type LlmConfigurationSet,
} from "./llm-call-config.js";
import { llmRunRoot } from "../llm-runtime/run-root.js";

type JsonObject = Record<string, unknown>;
const execFileAsync = promisify(execFile);

const PROMPT_ONLY_ROLES = new Set([
  "candidate-source-reader",
  "candidate-source-coverage-verifier",
  "candidate-source-repairer",
  "candidate-intelligence",
  "job-requirement-assessor",
  "tier2-requirement-assessor",
  "independent-fit-verifier",
  "job-requirement-repairer",
  "vacancy-source-navigator",
]);

const PROMPT_ONLY_FORBIDDEN_ITEM_TYPES = new Set([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
]);

export interface StartThreadOptions {
  cwd: string;
  /** Stable id from src/backend/control-flow/llm-call-catalog.ts. */
  callId?: string;
  role: string;
  sandbox: "read-only" | "workspace-write";
  model?: string;
  approvalPolicy?: "untrusted" | "on-request" | "never";
  developerInstructions: string;
  webSearch?: {
    mode: "disabled" | "cached" | "live";
  };
  executionContext?: LlmExecutionContext;
}

export interface StartTurnOptions {
  threadId: string;
  prompt: string;
  cwd: string;
  sandbox: "readOnly" | "workspaceWrite";
  outputSchema?: JsonObject;
  model?: string;
  approvalPolicy?: "untrusted" | "on-request" | "never";
  effort?: "low" | "medium" | "high";
  timeoutMs?: number;
}

export interface CodexRunObservation {
  threadId: string;
  turnId: string;
  callId: string;
  role: string;
  model: string;
  status: "completed" | "failed";
  runDirectory: string;
  durationMs: number;
  usage: Record<string, unknown>;
  executionContext?: LlmExecutionContext;
  finalText?: string;
  error?: string;
}

export interface LlmExecutionContext {
  userId: string;
  workflowRunId?: string;
}

interface ActiveExec {
  child: ChildProcessWithoutNullStreams;
  threadId: string;
  turnId: string;
  executionContext?: LlmExecutionContext;
}

/**
 * Process-isolated Codex harness. Thread methods define the orchestration
 * boundary, while every model turn is a fresh `codex exec --ephemeral`
 * process with an explicit schema and trace.
 */
export class CodexExecClient {
  private runtimeInfo: CodexRuntimeInfo | null = null;
  private codexHome: string | null = null;
  private readonly threads = new Map<string, StartThreadOptions>();
  private readonly active = new Map<string, ActiveExec>();
  private readonly executionContexts =
    new AsyncLocalStorage<LlmExecutionContext>();
  private executionPaused = false;
  private executionGeneration = 0;

  constructor(
    private readonly projectRoot = process.cwd(),
    private readonly llmConfiguration?: LlmConfigurationSet,
  ) {}

  onNotification: (message: JsonObject) => void | Promise<void> = () => undefined;
  onTurnStarted: (threadId: string, turnId: string) => void = () => undefined;
  /** Optional read-only observation hook used by eval and inspection runners. */
  onRunCompleted: (
    observation: CodexRunObservation,
  ) => void | Promise<void> = () => undefined;
  onServerRequest: (request: RpcRequest) => Promise<unknown> = async () => ({
    decision: "decline",
  });
  onStderr: (line: string) => void = () => undefined;
  /** Deployment-wide gate checked immediately before every model turn. */
  beforeTurn: () => void | Promise<void> = () => undefined;

  async start(): Promise<CodexRuntimeInfo> {
    if (this.runtimeInfo) return this.runtimeInfo;
    const binary = await discoverCodexBinary();
    const version = await getCodexVersion(binary);
    const codexHome = await this.ensureCodexHome();
    const serviceTier = process.env.ROLEGAIN_SERVICE_TIER || "fast";
    const login = await execFileAsync(
      binary,
      [
        "--config",
        `service_tier=\"${serviceTier}\"`,
        "login",
        "status",
      ],
      {
        windowsHide: true,
        timeout: 20_000,
        env: { ...process.env, CODEX_HOME: codexHome },
      },
    ).catch((error: unknown) => ({
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    }));
    const loginText = `${login.stdout || ""}\n${login.stderr || ""}`;
    const primary = process.env.ROLEGAIN_MODEL || "gpt-5.4";
    const fast = process.env.ROLEGAIN_FAST_MODEL || "gpt-5.4-mini";
    const search = process.env.ROLEGAIN_SEARCH_MODEL || fast;
    const modelIds = [...new Set([primary, fast, search])];
    this.runtimeInfo = {
      available: true,
      binary,
      version,
      compatible: version === SUPPORTED_CODEX_VERSION,
      authenticated: loginStatusIsAuthenticated(loginText),
      authMode: /chatgpt/i.test(loginText) ? "chatgpt" : "unknown",
      model: primary,
      models: modelIds.map((id, index) => ({
        id,
        displayName: id,
        isDefault: index === 0,
      })),
    };
    return this.runtimeInfo;
  }

  info(): CodexRuntimeInfo | null {
    return this.runtimeInfo;
  }

  async startThread(options: StartThreadOptions): Promise<CodexThread> {
    this.assertExecutionAllowed();
    const id = randomUUID();
    this.threads.set(id, {
      ...options,
      executionContext:
        options.executionContext ?? this.currentExecutionContext(),
    });
    await this.onNotification({
      method: "thread/started",
      params: { thread: { id, modelProvider: "openai" } },
    });
    return { id, modelProvider: "openai" };
  }

  async resumeThread(threadId: string): Promise<CodexThread> {
    this.assertExecutionAllowed();
    if (!this.threads.has(threadId)) {
      throw new Error(
        "This Codex exec context is no longer available; start a fresh scoped run",
      );
    }
    return { id: threadId, modelProvider: "openai" };
  }

  async runTurn(options: StartTurnOptions): Promise<CodexTurnResult> {
    await this.beforeTurn();
    this.assertExecutionAllowed();
    const executionGeneration = this.executionGeneration;
    const runtime = await this.start();
    this.assertExecutionAllowed(executionGeneration);
    if (!runtime.authenticated) throw new Error("Codex is not authenticated");
    const context = this.threads.get(options.threadId);
    if (!context) throw new Error(`Unknown Codex exec context ${options.threadId}`);
    const resolvedConfig = await resolveLlmCallConfig({
      projectRoot: this.projectRoot,
      configuration: this.llmConfiguration,
      callId: context.callId,
      production: {
        model: options.model || context.model || runtime.model || "gpt-5.4",
        effort: options.effort || "medium",
        role: context.role,
        rolePrompt: context.developerInstructions,
        skillName: skillForLlmCall(context.callId),
        outputSchema: options.outputSchema,
        sandbox: options.sandbox,
        approvalPolicy:
          options.approvalPolicy || context.approvalPolicy || "never",
        timeoutMs: options.timeoutMs ?? 15 * 60_000,
        webSearch: context.webSearch?.mode || "disabled",
      },
    });

    const turnId = randomUUID();
    const startedAt = Date.now();
    const runRoot = path.join(
      llmRunRoot(this.projectRoot),
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeName(resolvedConfig.role)}-${turnId.slice(0, 8)}`,
    );
    await mkdir(runRoot, { recursive: true });
    const schemaPath = path.join(runRoot, "schema.json");
    const resultPath = path.join(runRoot, "result.json");
    const rawResultPath = path.join(runRoot, "result.raw.json");
    const eventsPath = path.join(runRoot, "events.jsonl");
    const stderrPath = path.join(runRoot, "stderr.log");
    const promptPath = path.join(runRoot, "prompt.txt");
    const runPath = path.join(runRoot, "run.json");
    const gatewayPath = path.join(runRoot, "gateway.json");
    const resolvedConfigPath = path.join(runRoot, "llm-config.json");
    const semanticEvidenceTurn =
      resolvedConfig.role === "candidate-source-reader" ||
      resolvedConfig.role === "candidate-intelligence";
    const promptOnlyTurn = isPromptOnlyRole(resolvedConfig.role);
    const executionCwd = semanticEvidenceTurn || promptOnlyTurn
      ? path.join(runRoot, "isolated-workspace")
      : options.cwd;
    await mkdir(executionCwd, { recursive: true });
    const promptOnlyBoundary = promptOnlyTurn
      ? "\n\nThis is a prompt-only task. All permitted evidence is already present below. Do not use shell commands, repository files, web search, MCP tools, or any external tool. Return only the requested structured output."
      : "";
    const skillName = resolvedConfig.skillName;
    if (context.callId && !skillName)
      throw new Error(`No official Codex skill is registered for ${context.callId}`);
    await materializeSkillOverride(
      this.projectRoot,
      executionCwd,
      resolvedConfig,
    );
    const skillInstruction = skillName
      ? `\n\nUse $${skillName}. Follow that skill's procedure for this call.`
      : "";
    const fullPrompt = `${resolvedConfig.rolePrompt.trim()}${skillInstruction}${promptOnlyBoundary}\n\n--- TASK ---\n${options.prompt.trim()}\n`;
    await writeFile(promptPath, fullPrompt, "utf8");
    if (resolvedConfig.outputSchema)
      await writeFile(
        schemaPath,
        JSON.stringify(resolvedConfig.outputSchema, null, 2),
        "utf8",
      );
    await writeFile(
      resolvedConfigPath,
      JSON.stringify(serializableResolvedConfig(resolvedConfig), null, 2),
      "utf8",
    );
    await writeFile(
      runPath,
      JSON.stringify(
        {
          threadId: options.threadId,
          turnId,
          callId: context.callId || context.role,
          skill: skillName,
          configurationId: resolvedConfig.configurationId,
          role: resolvedConfig.role,
          model: resolvedConfig.model,
          effort: resolvedConfig.effort,
          sandbox: resolvedConfig.sandbox,
          webSearch: resolvedConfig.webSearch,
          timeoutMs: resolvedConfig.timeoutMs,
          executionCwd,
          startedAt: new Date(startedAt).toISOString(),
          status: "running",
        },
        null,
        2,
      ),
      "utf8",
    );

    const args = [
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--config",
      `service_tier=\"${process.env.ROLEGAIN_SERVICE_TIER || "fast"}\"`,
      "--ephemeral",
      "--skip-git-repo-check",
      "--json",
      "--sandbox",
      resolvedConfig.sandbox === "workspaceWrite" ? "workspace-write" : "read-only",
      "--cd",
      executionCwd,
      "--output-last-message",
      resultPath,
      "--model",
      resolvedConfig.model,
      "--config",
      `model_reasoning_effort=\"${resolvedConfig.effort}\"`,
      "--config",
      "features.shell_tool=false",
      "--config",
      "features.apps=false",
      "--config",
      "features.remote_plugin=false",
    ];
    if (resolvedConfig.outputSchema) args.push("--output-schema", schemaPath);
    if (resolvedConfig.webSearch === "live")
      args.push("--config", 'web_search="live"');
    else if (resolvedConfig.webSearch === "cached")
      args.push("--config", 'web_search="cached"');
    else args.push("--config", 'web_search="disabled"');
    args.push("-");

    this.assertExecutionAllowed(executionGeneration);
    const child = spawn(runtime.binary, args, {
      cwd: executionCwd,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CODEX_HOME: this.codexHome || (await this.ensureCodexHome()),
        NO_COLOR: "1",
      },
    });
    this.active.set(turnId, {
      child,
      threadId: options.threadId,
      turnId,
      executionContext: context.executionContext,
    });
    this.onTurnStarted(options.threadId, turnId);
    await this.onNotification({
      method: "turn/started",
      params: { threadId: options.threadId, turn: { id: turnId, status: "inProgress" } },
    });

    const items: JsonObject[] = [];
    let usage: JsonObject = {};
    let codexThreadId = "";
    let stderrText = "";
    let policyViolation = "";
    const events = createWriteStream(eventsPath, { flags: "a" });
    const stderr = createWriteStream(stderrPath, { flags: "a" });
    createInterface({ input: child.stdout }).on("line", (line) => {
      events.write(`${line}\n`);
      const parsed = parseJsonObject(line);
      if (!parsed) return;
      const violation = llmCallToolViolation(
        context.callId,
        resolvedConfig.role,
        parsed,
      );
      if (violation && !policyViolation) {
        policyViolation = violation;
        void terminateProcessTree(child);
      }
      if (parsed.type === "thread.started" && typeof parsed.thread_id === "string")
        codexThreadId = parsed.thread_id;
      if (parsed.type === "turn.completed") usage = asObject(parsed.usage);
      const notification = execEventToNotification(parsed, options.threadId, turnId);
      if (notification) {
        const params = asObject(notification.params);
        const item = asObject(params.item);
        if (Object.keys(item).length) items.push(item);
        void this.onNotification(notification);
      }
    });
    createInterface({ input: child.stderr }).on("line", (line) => {
      stderr.write(`${line}\n`);
      stderrText = `${stderrText}${line}\n`.slice(-8_000);
      this.onStderr(line);
    });
    child.stdin.end(fullPrompt);

      const timeoutMs = resolvedConfig.timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    try {
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          timer = setTimeout(() => {
            void terminateProcessTree(child);
            reject(new Error(`Codex exec ${turnId} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          child.once("error", reject);
          child.once("exit", (code, signal) => resolve({ code, signal }));
        },
      );
      if (policyViolation) throw new Error(policyViolation);
      if (exit.code !== 0) {
        throw new Error(
          `Codex exec failed (code ${exit.code}, signal ${exit.signal || "none"})${stderrText.trim() ? `: ${stderrText.trim()}` : ""}; trace: ${eventsPath}`,
        );
      }
      const finalText = await readFile(resultPath, "utf8");
      const gateway = evaluateResultGateway({
        callId: context.callId || context.role,
        finalText,
        outputSchema: resolvedConfig.outputSchema,
        prompt: options.prompt,
      });
      await writeFile(gatewayPath, JSON.stringify(gateway.report, null, 2), "utf8");
      if (!gateway.report.accepted) throw new ResultGatewayError(gateway.report);
      let acceptedText = finalText.trim();
      if (gateway.report.adjustments.length > 0 && gateway.output !== undefined) {
        await writeFile(rawResultPath, finalText, "utf8");
        acceptedText = JSON.stringify(gateway.output);
        await writeFile(resultPath, `${JSON.stringify(gateway.output, null, 2)}\n`, "utf8");
      }
      const durationMs = Date.now() - startedAt;
      await this.onNotification({
        method: "turn/completed",
        params: {
          threadId: options.threadId,
          turn: { id: turnId, status: "completed", durationMs },
        },
      });
      await writeRunCompletion(runPath, {
        status: "completed",
        completedAt: new Date().toISOString(),
        durationMs,
        codexThreadId,
        usage,
        executionContext: context.executionContext,
        artifacts: {
          promptSha256: await fileSha256(promptPath),
          schemaSha256: resolvedConfig.outputSchema
            ? await fileSha256(schemaPath)
            : undefined,
          llmConfigSha256: await fileSha256(resolvedConfigPath),
          resultSha256: await fileSha256(resultPath),
          rawResultSha256:
            gateway.report.adjustments.length > 0
              ? await fileSha256(rawResultPath)
              : undefined,
          gatewaySha256: await fileSha256(gatewayPath),
        },
      });
      await this.observeRun({
        threadId: options.threadId,
        turnId,
        callId: context.callId || context.role,
        role: resolvedConfig.role,
        model: resolvedConfig.model,
        status: "completed",
        runDirectory: runRoot,
        durationMs,
        usage,
        executionContext: context.executionContext,
        finalText: acceptedText,
      });
      return {
        threadId: options.threadId,
        turnId,
        status: "completed",
        finalText: acceptedText,
        items,
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      await this.onNotification({
        method: "turn/completed",
        params: {
          threadId: options.threadId,
          turn: { id: turnId, status: "failed", durationMs },
        },
      });
      await writeRunCompletion(runPath, {
        status: "failed",
        completedAt: new Date().toISOString(),
        durationMs,
        error: error instanceof Error ? error.message : String(error),
        gateway:
          error instanceof ResultGatewayError ? error.report : undefined,
      });
      await this.observeRun({
        threadId: options.threadId,
        turnId,
        callId: context.callId || context.role,
        role: resolvedConfig.role,
        model: resolvedConfig.model,
        status: "failed",
        runDirectory: runRoot,
        durationMs,
        usage,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      events.end();
      stderr.end();
      this.active.delete(turnId);
    }
  }

  async interruptTurn(_threadId: string, turnId: string): Promise<void> {
    const active = this.active.get(turnId);
    if (active) await terminateProcessTree(active.child);
  }

  async pauseAllTurns(): Promise<void> {
    this.executionPaused = true;
    this.executionGeneration += 1;
    await Promise.all(
      [...this.active.values()].map((active) =>
        terminateProcessTree(active.child),
      ),
    );
  }

  async pauseTurnsForUser(userId: string): Promise<void> {
    await Promise.all(
      [...this.active.values()]
        .filter((active) => active.executionContext?.userId === userId)
        .map((active) => terminateProcessTree(active.child)),
    );
  }

  resumeTurns(): void {
    this.executionPaused = false;
  }

  activeTurnCount(): number {
    return this.active.size;
  }

  runWithExecutionContext<T>(
    context: LlmExecutionContext,
    work: () => Promise<T>,
  ) {
    return this.executionContexts.run(context, work);
  }

  protected currentExecutionContext() {
    return this.executionContexts.getStore();
  }

  async compactThread(_threadId: string): Promise<void> {
    // Every turn is ephemeral, so there is no accumulated context to compact.
  }

  async close(): Promise<void> {
    this.executionPaused = true;
    this.executionGeneration += 1;
    await Promise.all(
      [...this.active.values()].map((active) => terminateProcessTree(active.child)),
    );
    this.active.clear();
    this.threads.clear();
    this.runtimeInfo = null;
  }

  private assertExecutionAllowed(generation = this.executionGeneration): void {
    if (this.executionPaused || generation !== this.executionGeneration)
      throw new Error("Background execution is stopped");
  }

  private async ensureCodexHome() {
    if (this.codexHome) return this.codexHome;
    const codexHome = resolveCodexHome();
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    this.codexHome = codexHome;
    return codexHome;
  }

  private async observeRun(observation: CodexRunObservation) {
    try {
      await this.onRunCompleted(observation);
    } catch (error) {
      this.onStderr(
        `Codex run observer failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** Use the same authenticated Codex home as the CLI/Desktop unless overridden. */
export function resolveCodexHome() {
  const configured =
    process.env.ROLEGAIN_CODEX_HOME || process.env.CODEX_HOME;
  return configured ? path.resolve(configured) : path.join(homedir(), ".codex");
}

export function loginStatusIsAuthenticated(status: string) {
  return /\blogged in using\b/i.test(status) && !/\bnot logged in\b/i.test(status);
}

export function isPromptOnlyRole(role: string) {
  return PROMPT_ONLY_ROLES.has(role);
}

export function promptOnlyToolViolation(
  role: string,
  event: JsonObject,
): string | undefined {
  if (!isPromptOnlyRole(role)) return undefined;
  return forbiddenToolEvent(`Prompt-only role ${role}`, event, false);
}

export function llmCallToolViolation(
  callId: string | undefined,
  role: string,
  event: JsonObject,
): string | undefined {
  if (!callId || !(callId in LLM_CALL_SKILLS))
    return promptOnlyToolViolation(role, event);
  return forbiddenToolEvent(
    `LLM call ${callId}`,
    event,
    callId === "search.web-discovery",
  );
}

function forbiddenToolEvent(
  label: string,
  event: JsonObject,
  allowWebSearch: boolean,
): string | undefined {
  if (event.type !== "item.started" && event.type !== "item.completed")
    return undefined;
  const itemType = asObject(event.item).type;
  if (allowWebSearch && itemType === "web_search") return undefined;
  if (
    typeof itemType !== "string" ||
    !PROMPT_ONLY_FORBIDDEN_ITEM_TYPES.has(itemType)
  )
    return undefined;
  return `${label} attempted forbidden tool use (${itemType})`;
}

async function writeRunCompletion(runPath: string, completion: JsonObject) {
  const current = JSON.parse(await readFile(runPath, "utf8")) as JsonObject;
  await writeFile(runPath, JSON.stringify({ ...current, ...completion }, null, 2), "utf8");
}

function execEventToNotification(
  event: JsonObject,
  threadId: string,
  turnId: string,
): JsonObject | undefined {
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "item.started" || type === "item.completed") {
    return {
      method: type === "item.started" ? "item/started" : "item/completed",
      params: {
        threadId,
        turnId,
        item: normalizeExecItem(asObject(event.item)),
      },
    };
  }
  return undefined;
}

function normalizeExecItem(item: JsonObject): JsonObject {
  const type = typeof item.type === "string" ? item.type : "item";
  const camelType: Record<string, string> = {
    agent_message: "agentMessage",
    command_execution: "commandExecution",
    file_change: "fileChange",
    web_search: "webSearch",
    context_compaction: "contextCompaction",
    mcp_tool_call: "mcpToolCall",
  };
  return { ...item, type: camelType[type] || type };
}

async function terminateProcessTree(child: ChildProcessWithoutNullStreams) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    await execFileAsync("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 5_000,
    }).catch(() => undefined);
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    await waitForChildExit(child, 1_500);
    if (child.exitCode === null && child.signalCode === null)
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
  }
}

async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      child.off("exit", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    child.once("exit", done);
  });
}

function parseJsonObject(value: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : undefined;
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function safeName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "agent";
}

async function fileSha256(file: string) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}
