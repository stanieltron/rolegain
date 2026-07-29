import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CodexExecClient,
  type CodexRunObservation,
  type StartThreadOptions,
  type StartTurnOptions,
} from "../codex-runtime/client.js";
import {
  resolveLlmCallConfig,
  serializableResolvedConfig,
  type LlmConfigurationSet,
} from "../codex-runtime/llm-call-config.js";
import type {
  CodexRuntimeInfo,
  CodexThread,
  CodexTurnResult,
} from "../codex-runtime/protocol.js";
import {
  evaluateResultGateway,
  ResultGatewayError,
} from "../codex-runtime/result-gateway.js";
import { skillForLlmCall } from "../codex-runtime/skill-registry.js";

type JsonObject = Record<string, unknown>;

interface ActiveApiTurn {
  controller: AbortController;
  threadId: string;
  userId?: string;
}

/**
 * OpenAI-compatible transport for the existing Rolegain call harness.
 *
 * Call manifests, skills, schemas and result gateways remain authoritative;
 * only request execution and response-envelope extraction differ from Codex.
 */
export class OpenAiCompatibleClient extends CodexExecClient {
  private apiRuntimeInfo: CodexRuntimeInfo | null = null;
  private readonly apiThreads = new Map<string, StartThreadOptions>();
  private readonly apiActive = new Map<string, ActiveApiTurn>();
  private apiExecutionPaused = false;
  private apiExecutionGeneration = 0;

  constructor(
    private readonly apiProjectRoot = process.cwd(),
    private readonly apiLlmConfiguration?: LlmConfigurationSet,
  ) {
    super(apiProjectRoot, apiLlmConfiguration);
  }

  override async start(): Promise<CodexRuntimeInfo> {
    if (this.apiRuntimeInfo) return this.apiRuntimeInfo;
    const model = process.env.ROLEGAIN_API_MODEL || "api-model";
    this.apiRuntimeInfo = {
      available: true,
      binary: "openai-compatible-api",
      version: "api-v1",
      compatible: true,
      authenticated: hasApiKey(),
      authMode: "api-key",
      model,
      models: [{ id: model, displayName: model, isDefault: true }],
    };
    return this.apiRuntimeInfo;
  }

  override info(): CodexRuntimeInfo | null {
    return this.apiRuntimeInfo;
  }

  override async startThread(options: StartThreadOptions): Promise<CodexThread> {
    this.assertApiExecutionAllowed();
    const id = randomUUID();
    this.apiThreads.set(id, {
      ...options,
      executionContext:
        options.executionContext ?? this.currentExecutionContext(),
    });
    await this.onNotification({
      method: "thread/started",
      params: { thread: { id, modelProvider: "openai-compatible-api" } },
    });
    return { id, modelProvider: "openai-compatible-api" };
  }

  override async resumeThread(threadId: string): Promise<CodexThread> {
    this.assertApiExecutionAllowed();
    if (!this.apiThreads.has(threadId))
      throw new Error(
        "This API context is no longer available; start a fresh scoped run",
      );
    return { id: threadId, modelProvider: "openai-compatible-api" };
  }

  override async runTurn(options: StartTurnOptions): Promise<CodexTurnResult> {
    this.assertApiExecutionAllowed();
    const executionGeneration = this.apiExecutionGeneration;
    const runtime = await this.start();
    this.assertApiExecutionAllowed(executionGeneration);
    const context = this.apiThreads.get(options.threadId);
    if (!context)
      throw new Error(`Unknown API execution context ${options.threadId}`);

    const resolvedConfig = await resolveLlmCallConfig({
      projectRoot: this.apiProjectRoot,
      configuration: this.apiLlmConfiguration,
      callId: context.callId,
      production: {
        model:
          process.env.ROLEGAIN_API_MODEL ||
          options.model ||
          context.model ||
          runtime.model ||
          "api-model",
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
    if (context.callId && !resolvedConfig.skillName)
      throw new Error(`No official skill is registered for ${context.callId}`);

    const skillContent = resolvedConfig.skillSourcePath
      ? skillBody(
          await readFile(
            path.resolve(
              this.apiProjectRoot,
              resolvedConfig.skillSourcePath,
            ),
            "utf8",
          ),
        )
      : "";
    const systemPrompt = compileSystemPrompt(
      resolvedConfig.rolePrompt,
      skillContent,
      resolvedConfig.webSearch,
    );
    const fullPrompt = `${systemPrompt}\n\n--- TASK ---\n${options.prompt.trim()}\n`;
    const turnId = randomUUID();
    const startedAt = Date.now();
    const runRoot = path.join(
      this.apiProjectRoot,
      ".agent-runtime",
      "runs",
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeName(resolvedConfig.role)}-${turnId.slice(0, 8)}`,
    );
    await mkdir(runRoot, { recursive: true });
    const promptPath = path.join(runRoot, "prompt.txt");
    const schemaPath = path.join(runRoot, "schema.json");
    const resultPath = path.join(runRoot, "result.json");
    const rawResultPath = path.join(runRoot, "result.raw.json");
    const gatewayPath = path.join(runRoot, "gateway.json");
    const requestPath = path.join(runRoot, "request.json");
    const responsePath = path.join(runRoot, "response.json");
    const configPath = path.join(runRoot, "llm-config.json");
    const runPath = path.join(runRoot, "run.json");
    await writeFile(promptPath, fullPrompt, "utf8");
    if (resolvedConfig.outputSchema)
      await writeFile(
        schemaPath,
        JSON.stringify(resolvedConfig.outputSchema, null, 2),
        "utf8",
      );
    await writeFile(
      configPath,
      JSON.stringify(serializableResolvedConfig(resolvedConfig), null, 2),
      "utf8",
    );

    const request = apiRequest({
      callId: context.callId || context.role,
      model: resolvedConfig.model,
      effort: resolvedConfig.effort,
      systemPrompt,
      prompt: options.prompt,
      outputSchema: resolvedConfig.outputSchema,
      webSearch: resolvedConfig.webSearch,
    });
    await writeFile(requestPath, JSON.stringify(request, null, 2), "utf8");
    await writeFile(
      runPath,
      JSON.stringify(
        {
          threadId: options.threadId,
          turnId,
          callId: context.callId || context.role,
          provider: "openai-compatible-api",
          baseUrl: apiBaseUrl(),
          configurationId: resolvedConfig.configurationId,
          role: resolvedConfig.role,
          skill: resolvedConfig.skillName,
          model: resolvedConfig.model,
          effort: resolvedConfig.effort,
          webSearch: resolvedConfig.webSearch,
          timeoutMs: resolvedConfig.timeoutMs,
          startedAt: new Date(startedAt).toISOString(),
          status: "running",
        },
        null,
        2,
      ),
      "utf8",
    );

    const controller = new AbortController();
    this.apiActive.set(turnId, {
      controller,
      threadId: options.threadId,
      userId: context.executionContext?.userId,
    });
    this.onTurnStarted(options.threadId, turnId);
    await this.onNotification({
      method: "turn/started",
      params: {
        threadId: options.threadId,
        turn: { id: turnId, status: "inProgress" },
      },
    });

    let timer: NodeJS.Timeout | undefined;
    let usage: JsonObject = {};
    try {
      this.assertApiExecutionAllowed(executionGeneration);
      timer = setTimeout(
        () => controller.abort(),
        resolvedConfig.timeoutMs,
      );
      const response = await fetch(apiEndpoint(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${requiredApiKey()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const responseText = await response.text();
      const responseJson = parseJsonObject(responseText);
      await writeFile(
        responsePath,
        responseJson
          ? JSON.stringify(responseJson, null, 2)
          : responseText,
        "utf8",
      );
      if (!response.ok)
        throw new Error(
          `LLM API request failed (${response.status} ${response.statusText}): ${apiErrorMessage(responseJson, responseText)}`,
        );
      if (!responseJson)
        throw new Error("LLM API returned a non-JSON response");

      usage = asObject(responseJson.usage);
      const finalText = apiResponseText(responseJson);
      if (!finalText.trim())
        throw new Error("LLM API response did not contain assistant text");
      await writeFile(resultPath, `${finalText.trim()}\n`, "utf8");
      const gateway = evaluateResultGateway({
        callId: context.callId || context.role,
        finalText,
        outputSchema: resolvedConfig.outputSchema,
        prompt: options.prompt,
      });
      await writeFile(
        gatewayPath,
        JSON.stringify(gateway.report, null, 2),
        "utf8",
      );
      if (!gateway.report.accepted)
        throw new ResultGatewayError(gateway.report);
      let acceptedText = finalText.trim();
      if (
        gateway.report.adjustments.length > 0 &&
        gateway.output !== undefined
      ) {
        await writeFile(rawResultPath, finalText, "utf8");
        acceptedText = JSON.stringify(gateway.output);
        await writeFile(
          resultPath,
          `${JSON.stringify(gateway.output, null, 2)}\n`,
          "utf8",
        );
      }

      const durationMs = Date.now() - startedAt;
      await writeRunCompletion(runPath, {
        status: "completed",
        completedAt: new Date().toISOString(),
        durationMs,
        providerResponseId:
          typeof responseJson.id === "string" ? responseJson.id : undefined,
        usage,
        executionContext: context.executionContext,
        artifacts: {
          promptSha256: await fileSha256(promptPath),
          schemaSha256: resolvedConfig.outputSchema
            ? await fileSha256(schemaPath)
            : undefined,
          requestSha256: await fileSha256(requestPath),
          responseSha256: await fileSha256(responsePath),
          resultSha256: await fileSha256(resultPath),
          gatewaySha256: await fileSha256(gatewayPath),
        },
      });
      await this.onNotification({
        method: "turn/completed",
        params: {
          threadId: options.threadId,
          turn: { id: turnId, status: "completed", durationMs },
        },
      });
      await this.observeApiRun({
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
        items: [],
      };
    } catch (error) {
      const normalized =
        error instanceof Error && error.name === "AbortError"
          ? new Error(
              `LLM API turn ${turnId} timed out after ${resolvedConfig.timeoutMs}ms`,
            )
          : error;
      const durationMs = Date.now() - startedAt;
      await writeRunCompletion(runPath, {
        status: "failed",
        completedAt: new Date().toISOString(),
        durationMs,
        error:
          normalized instanceof Error
            ? normalized.message
            : String(normalized),
        gateway:
          normalized instanceof ResultGatewayError
            ? normalized.report
            : undefined,
      });
      await this.onNotification({
        method: "turn/completed",
        params: {
          threadId: options.threadId,
          turn: { id: turnId, status: "failed", durationMs },
        },
      });
      await this.observeApiRun({
        threadId: options.threadId,
        turnId,
        callId: context.callId || context.role,
        role: resolvedConfig.role,
        model: resolvedConfig.model,
        status: "failed",
        runDirectory: runRoot,
        durationMs,
        usage,
        error:
          normalized instanceof Error
            ? normalized.message
            : String(normalized),
      });
      throw normalized;
    } finally {
      if (timer) clearTimeout(timer);
      this.apiActive.delete(turnId);
    }
  }

  override async interruptTurn(
    _threadId: string,
    turnId: string,
  ): Promise<void> {
    this.apiActive.get(turnId)?.controller.abort();
  }

  override async pauseAllTurns(): Promise<void> {
    this.apiExecutionPaused = true;
    this.apiExecutionGeneration += 1;
    for (const active of this.apiActive.values()) active.controller.abort();
  }

  override async pauseTurnsForUser(userId: string): Promise<void> {
    for (const active of this.apiActive.values())
      if (active.userId === userId) active.controller.abort();
  }

  override resumeTurns(): void {
    this.apiExecutionPaused = false;
  }

  override activeTurnCount(): number {
    return this.apiActive.size;
  }

  override async compactThread(_threadId: string): Promise<void> {
    // API turns are independent; retry context is supplied explicitly by calls.
  }

  override async close(): Promise<void> {
    this.apiExecutionPaused = true;
    this.apiExecutionGeneration += 1;
    for (const active of this.apiActive.values()) active.controller.abort();
    this.apiActive.clear();
    this.apiThreads.clear();
    this.apiRuntimeInfo = null;
  }

  private assertApiExecutionAllowed(
    generation = this.apiExecutionGeneration,
  ) {
    if (
      this.apiExecutionPaused ||
      generation !== this.apiExecutionGeneration
    )
      throw new Error("Background execution is stopped");
  }

  private async observeApiRun(observation: CodexRunObservation) {
    try {
      await this.onRunCompleted(observation);
    } catch (error) {
      this.onStderr(
        `API run observer failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function apiRequest(input: {
  callId: string;
  model: string;
  effort: "low" | "medium" | "high";
  systemPrompt: string;
  prompt: string;
  outputSchema?: JsonObject;
  webSearch: "disabled" | "cached" | "live";
}) {
  const request: JsonObject = {
    model: input.model,
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.prompt.trim() },
    ],
  };
  if (process.env.ROLEGAIN_API_OMIT_REASONING_EFFORT !== "true")
    request.reasoning_effort = input.effort;
  if (input.outputSchema)
    request.response_format = {
      type: "json_schema",
      json_schema: {
        name: safeSchemaName(input.callId),
        strict: true,
        schema: input.outputSchema,
      },
    };
  const maxOutputTokens = Number.parseInt(
    process.env.ROLEGAIN_API_MAX_OUTPUT_TOKENS || "",
    10,
  );
  if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0)
    request.max_completion_tokens = maxOutputTokens;
  if (input.webSearch !== "disabled") {
    const providerPayload = process.env.ROLEGAIN_API_WEB_SEARCH_BODY;
    if (!providerPayload)
      throw new Error(
        `${input.callId} requires provider-managed web search; configure ROLEGAIN_API_WEB_SEARCH_BODY with the selected provider's request fields`,
      );
    Object.assign(request, parseEnvironmentObject(
      "ROLEGAIN_API_WEB_SEARCH_BODY",
      providerPayload,
    ));
  }
  return request;
}

function compileSystemPrompt(
  rolePrompt: string,
  skill: string,
  webSearch: "disabled" | "cached" | "live",
) {
  const toolBoundary =
    webSearch === "disabled"
      ? "This is a prompt-only call. Use only the supplied task data. Do not request or imply external tool use."
      : "Use only the provider-managed web-search capability configured for this call. Do not request any other tool.";
  return [
    rolePrompt.trim(),
    toolBoundary,
    skill ? `--- TRUSTED PROCEDURE ---\n${skill.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function skillBody(content: string) {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}

function apiResponseText(response: JsonObject) {
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const message = asObject(asObject(choices[0]).message);
  if (
    message.parsed &&
    typeof message.parsed === "object"
  )
    return JSON.stringify(message.parsed);
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content))
    return message.content
      .map((item) => {
        const part = asObject(item);
        return typeof part.text === "string" ? part.text : "";
      })
      .join("");
  return "";
}

function apiBaseUrl() {
  return (
    process.env.ROLEGAIN_API_BASE_URL ||
    "https://generativelanguage.googleapis.com/v1beta/openai"
  ).replace(/\/+$/, "");
}

function apiEndpoint() {
  return `${apiBaseUrl()}/chat/completions`;
}

function requiredApiKey() {
  const value = process.env.ROLEGAIN_API_KEY?.trim();
  if (!hasApiKey())
    throw new Error(
      "ROLEGAIN_API_KEY is missing; set a real provider API key in .env",
    );
  return value as string;
}

function hasApiKey() {
  const value = process.env.ROLEGAIN_API_KEY?.trim();
  return Boolean(
    value &&
      !/^replace[-_ ]?me/i.test(value) &&
      !/^your[-_ ]/i.test(value),
  );
}

function parseEnvironmentObject(name: string, value: string) {
  const parsed = parseJsonObject(value);
  if (!parsed) throw new Error(`${name} must contain a JSON object`);
  return parsed;
}

function apiErrorMessage(response: JsonObject | undefined, fallback: string) {
  const error = asObject(response?.error);
  if (typeof error.message === "string") return error.message;
  return fallback.slice(0, 2_000);
}

function parseJsonObject(value: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : undefined;
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function safeSchemaName(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 64) || "result";
}

function safeName(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50) || "agent"
  );
}

async function writeRunCompletion(
  runPath: string,
  completion: JsonObject,
) {
  const current = JSON.parse(await readFile(runPath, "utf8")) as JsonObject;
  await writeFile(
    runPath,
    JSON.stringify({ ...current, ...completion }, null, 2),
    "utf8",
  );
}

async function fileSha256(file: string) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}
