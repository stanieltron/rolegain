import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  materializeSkillOverride,
  resolveLlmCallConfig,
} from "../../src/codex-runtime/llm-call-config.js";

describe("versioned LLM call configuration", () => {
  it("preserves production values without overrides", async () => {
    const resolved = await resolveLlmCallConfig({
      projectRoot: process.cwd(),
      callId: "match.requirements",
      configuration: { id: "production-default-v1", overrides: {} },
      production: productionConfig(),
    });
    expect(resolved).toMatchObject({
      configurationId: "production-default-v1",
      model: "production-model",
      effort: "low",
      rolePrompt: "production role prompt",
      skillName: "rolegain-match-job-requirements",
    });
    expect(resolved.hashes.rolePromptSha256).toHaveLength(64);
    expect(resolved.hashes.outputSchemaSha256).toHaveLength(64);
  });

  it("resolves trusted prompt, schema, and skill files and materializes the skill", async () => {
    const root = path.join(
      process.cwd(),
      ".test-artifacts",
      "llm-call-config",
    );
    await mkdir(path.join(root, "variant"), { recursive: true });
    await writeFile(path.join(root, "variant", "role.md"), "variant role", "utf8");
    await writeFile(
      path.join(root, "variant", "schema.json"),
      JSON.stringify({ type: "object" }),
      "utf8",
    );
    await writeFile(
      path.join(root, "variant", "SKILL.md"),
      "# Variant skill\n",
      "utf8",
    );
    const relative = path.relative(process.cwd(), path.join(root, "variant"));
    const resolved = await resolveLlmCallConfig({
      projectRoot: process.cwd(),
      callId: "match.requirements",
      configuration: {
        id: "variant-v1",
        overrides: {
          "match.requirements": {
            model: "candidate-model",
            effort: "medium",
            rolePromptPath: path.join(relative, "role.md"),
            outputSchemaPath: path.join(relative, "schema.json"),
            skill: {
              name: "rolegain-match-job-requirements-variant",
              sourcePath: path.join(relative, "SKILL.md"),
            },
          },
        },
      },
      production: productionConfig(),
    });
    expect(resolved).toMatchObject({
      configurationId: "variant-v1",
      model: "candidate-model",
      effort: "medium",
      rolePrompt: "variant role",
      skillName: "rolegain-match-job-requirements-variant",
      outputSchema: { type: "object" },
    });

    const workspace = path.join(root, "workspace");
    await materializeSkillOverride(process.cwd(), workspace, resolved);
    const skill = await import("node:fs/promises").then(({ readFile }) =>
      readFile(
        path.join(
          workspace,
          ".agents",
          "skills",
          "rolegain-match-job-requirements-variant",
          "SKILL.md",
        ),
        "utf8",
      ),
    );
    expect(skill).toBe("# Variant skill\n");
  });

  it("rejects configuration paths outside the project", async () => {
    await expect(
      resolveLlmCallConfig({
        projectRoot: process.cwd(),
        callId: "match.requirements",
        configuration: {
          id: "unsafe",
          overrides: {
            "match.requirements": {
              rolePromptPath: "../outside.md",
            },
          },
        },
        production: productionConfig(),
      }),
    ).rejects.toThrow("escapes project root");
  });
});

function productionConfig() {
  return {
    model: "production-model",
    effort: "low" as const,
    role: "job-requirement-assessor",
    rolePrompt: "production role prompt",
    skillName: "rolegain-match-job-requirements",
    outputSchema: { type: "object" },
    sandbox: "readOnly" as const,
    approvalPolicy: "never" as const,
    timeoutMs: 1_000,
    webSearch: "disabled" as const,
  };
}
