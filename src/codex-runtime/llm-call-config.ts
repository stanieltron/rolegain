import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LlmCallId } from "./skill-registry.js";

type JsonObject = Record<string, unknown>;

export type ReasoningEffort = "low" | "medium" | "high";

export interface LlmSkillOverride {
  /** Skill name referenced as `$name` in the prompt. */
  name: string;
  /** Optional trusted repository-relative SKILL.md used instead of the production skill. */
  sourcePath?: string;
}

/**
 * A versioned, trusted override for one declared LLM call.
 *
 * Paths are resolved inside projectRoot. Eval code may use them, but request/user
 * input must never be copied into these fields without an allow-list.
 */
export interface LlmCallConfigOverride {
  model?: string;
  effort?: ReasoningEffort;
  role?: string;
  rolePrompt?: string;
  rolePromptPath?: string;
  skill?: LlmSkillOverride;
  outputSchema?: JsonObject;
  outputSchemaPath?: string;
  sandbox?: "readOnly" | "workspaceWrite";
  approvalPolicy?: "untrusted" | "on-request" | "never";
  timeoutMs?: number;
  webSearch?: "disabled" | "cached" | "live";
}

export type LlmCallConfigOverrides = Partial<
  Record<LlmCallId, LlmCallConfigOverride>
>;

export interface LlmConfigurationSet {
  /** Stable experiment identifier, for example `production-default-v1`. */
  id: string;
  overrides?: LlmCallConfigOverrides;
}

export interface ResolvedLlmCallConfig {
  configurationId: string;
  callId?: string;
  model: string;
  effort: ReasoningEffort;
  role: string;
  rolePrompt: string;
  skillName?: string;
  skillSourcePath?: string;
  outputSchema?: JsonObject;
  sandbox: "readOnly" | "workspaceWrite";
  approvalPolicy: "untrusted" | "on-request" | "never";
  timeoutMs: number;
  webSearch: "disabled" | "cached" | "live";
  hashes: {
    rolePromptSha256: string;
    outputSchemaSha256?: string;
    skillSha256?: string;
    resolvedConfigSha256: string;
  };
}

export interface ResolveLlmCallConfigInput {
  projectRoot: string;
  configuration?: LlmConfigurationSet;
  callId?: string;
  production: {
    model: string;
    effort: ReasoningEffort;
    role: string;
    rolePrompt: string;
    skillName?: string;
    outputSchema?: JsonObject;
    sandbox: "readOnly" | "workspaceWrite";
    approvalPolicy: "untrusted" | "on-request" | "never";
    timeoutMs: number;
    webSearch: "disabled" | "cached" | "live";
  };
}

export async function resolveLlmCallConfig(
  input: ResolveLlmCallConfigInput,
): Promise<ResolvedLlmCallConfig> {
  const override =
    input.callId && input.configuration?.overrides
      ? input.configuration.overrides[input.callId as LlmCallId]
      : undefined;
  const rolePrompt = override?.rolePromptPath
    ? await readTrustedProjectFile(input.projectRoot, override.rolePromptPath)
    : override?.rolePrompt ?? input.production.rolePrompt;
  const outputSchema = override?.outputSchemaPath
    ? parseSchema(
        override.outputSchemaPath,
        await readTrustedProjectFile(
          input.projectRoot,
          override.outputSchemaPath,
        ),
      )
    : override?.outputSchema ?? input.production.outputSchema;
  const skillName = override?.skill?.name ?? input.production.skillName;
  const productionSkillPath = skillName
    ? path.join(".agents", "skills", skillName, "SKILL.md")
    : undefined;
  const skillSourcePath =
    override?.skill?.sourcePath ??
    (productionSkillPath &&
    (await projectFileExists(input.projectRoot, productionSkillPath))
      ? productionSkillPath
      : undefined);
  const skillContent = skillSourcePath
    ? await readTrustedProjectFile(input.projectRoot, skillSourcePath)
    : undefined;

  const base = {
    configurationId: input.configuration?.id || "production-default",
    callId: input.callId,
    model: override?.model ?? input.production.model,
    effort: override?.effort ?? input.production.effort,
    role: override?.role ?? input.production.role,
    rolePrompt,
    skillName,
    skillSourcePath,
    outputSchema,
    sandbox: override?.sandbox ?? input.production.sandbox,
    approvalPolicy:
      override?.approvalPolicy ?? input.production.approvalPolicy,
    timeoutMs: override?.timeoutMs ?? input.production.timeoutMs,
    webSearch: override?.webSearch ?? input.production.webSearch,
  };
  const hashes = {
    rolePromptSha256: sha256(rolePrompt),
    outputSchemaSha256: outputSchema
      ? sha256(stableJson(outputSchema))
      : undefined,
    skillSha256: skillContent ? sha256(skillContent) : undefined,
    resolvedConfigSha256: sha256(stableJson(base)),
  };
  return { ...base, hashes };
}

export async function materializeSkillOverride(
  projectRoot: string,
  executionCwd: string,
  config: ResolvedLlmCallConfig,
) {
  if (!config.skillName || !config.skillSourcePath) return;
  const content = await readTrustedProjectFile(
    projectRoot,
    config.skillSourcePath,
  );
  const skillDirectory = path.join(
    executionCwd,
    ".agents",
    "skills",
    safeSkillName(config.skillName),
  );
  const destination = path.join(skillDirectory, "SKILL.md");
  const source = path.resolve(projectRoot, config.skillSourcePath);
  if (path.resolve(destination) === source) return;
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(destination, content, "utf8");
}

export function serializableResolvedConfig(config: ResolvedLlmCallConfig) {
  return {
    configurationId: config.configurationId,
    callId: config.callId,
    model: config.model,
    effort: config.effort,
    role: config.role,
    skillName: config.skillName,
    skillSourcePath: config.skillSourcePath,
    sandbox: config.sandbox,
    approvalPolicy: config.approvalPolicy,
    timeoutMs: config.timeoutMs,
    webSearch: config.webSearch,
    hashes: config.hashes,
  };
}

async function readTrustedProjectFile(projectRoot: string, sourcePath: string) {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, sourcePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(`LLM configuration path escapes project root: ${sourcePath}`);
  return readFile(resolved, "utf8");
}

async function projectFileExists(projectRoot: string, sourcePath: string) {
  try {
    await access(path.resolve(projectRoot, sourcePath));
    return true;
  } catch {
    return false;
  }
}

function parseSchema(sourcePath: string, content: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Invalid JSON output schema at ${sourcePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`Output schema at ${sourcePath} must be a JSON object`);
  return parsed as JsonObject;
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value))
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function safeSkillName(value: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value))
    throw new Error(`Invalid skill name in LLM configuration: ${value}`);
  return value;
}
