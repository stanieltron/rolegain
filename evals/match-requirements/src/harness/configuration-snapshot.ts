import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LlmConfigurationSet } from "../../../../src/codex-runtime/llm-call-config.js";
import {
  skillForLlmCall,
  type LlmCallId,
} from "../../../../src/codex-runtime/skill-registry.js";

const MATCH_CALL_IDS = [
  "match.requirements",
  "match.tier2-evidence",
  "match.verification",
  "match.repair",
] as const satisfies readonly LlmCallId[];

export async function snapshotMatchConfigurationSources(
  cwd: string,
  outputRoot: string,
  configuration?: LlmConfigurationSet,
) {
  const destination = path.join(outputRoot, "configuration-sources");
  await mkdir(destination, { recursive: true });
  const sources: Array<{
    callId: LlmCallId;
    kind: "skill" | "rolePrompt" | "outputSchema";
    sourcePath: string;
    snapshotPath: string;
    sha256: string;
  }> = [];
  for (const callId of MATCH_CALL_IDS) {
    const override = configuration?.overrides?.[callId];
    const skillName = override?.skill?.name || skillForLlmCall(callId);
    const files = [
      skillName
        ? {
            kind: "skill" as const,
            sourcePath:
              override?.skill?.sourcePath ||
              path.join(".agents", "skills", skillName, "SKILL.md"),
          }
        : undefined,
      override?.rolePromptPath
        ? {
            kind: "rolePrompt" as const,
            sourcePath: override.rolePromptPath,
          }
        : undefined,
      override?.outputSchemaPath
        ? {
            kind: "outputSchema" as const,
            sourcePath: override.outputSchemaPath,
          }
        : undefined,
    ].filter((file): file is NonNullable<typeof file> => Boolean(file));
    for (const file of files) {
      const resolved = trustedPath(cwd, file.sourcePath);
      const content = await readFile(resolved);
      const extension = path.extname(file.sourcePath) || ".txt";
      const snapshotName = `${callId.replaceAll(".", "-")}-${file.kind}${extension}`;
      const snapshotPath = path.join(destination, snapshotName);
      await writeFile(snapshotPath, content);
      sources.push({
        callId,
        kind: file.kind,
        sourcePath: file.sourcePath,
        snapshotPath: path.relative(outputRoot, snapshotPath),
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
  }
  const manifest = {
    configurationId: configuration?.id || "production-default",
    capturedAt: new Date().toISOString(),
    sources,
  };
  await writeFile(
    path.join(destination, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

function trustedPath(cwd: string, sourcePath: string) {
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, sourcePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(`Configuration source escapes project root: ${sourcePath}`);
  return resolved;
}
