import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { llmCallCatalog } from "../src/backend/control-flow/llm-call-catalog.js";
import { mapParallelOrdered } from "../src/search-match-shared/parallel.js";
import { RESULT_GATEWAY_CALL_IDS } from "../src/codex-runtime/result-gateway.js";
import { LLM_CALL_SKILLS } from "../src/codex-runtime/skill-registry.js";

const pipelineRoots = [
  "01-evidence-ingestion",
  "02-search",
  "03-match",
  "04-application-preparation",
] as const;

const modelBoundaryRoots = [...pipelineRoots, "02-search/v2"] as const;

describe("inspectable pipeline architecture", () => {
  it("keeps every LLM call as the same independently tweakable mini-program", async () => {
    const expectedFiles = [
      "command.ts",
      "index.ts",
      "input.ts",
      "memory.ts",
      "output.ts",
      "role-prompt.ts",
      "tools.ts",
    ];
    const directories = (
      await Promise.all(
        pipelineRoots.map((pipeline) =>
          llmCallDirectories(path.resolve("src", pipeline)),
        ),
      )
    ).flat();
    expect(directories).toHaveLength(llmCallCatalog.length);
    for (const directory of directories) {
      const files = (await readdir(directory)).sort();
      const label = path.relative(path.resolve("src"), directory);
      expect(files, label).toEqual(expectedFiles);
      const input = await readFile(path.join(directory, "input.ts"), "utf8");
      const output = await readFile(path.join(directory, "output.ts"), "utf8");
      const index = await readFile(path.join(directory, "index.ts"), "utf8");
      expect(input, label).toContain("buildInput");
      expect(output, label).toContain("outputSchema");
      for (const symbol of ["buildInput", "command", "outputSchema", "rolePrompt"])
        expect(index, `${label} export ${symbol}`).toContain(symbol);
    }
  });

  it("exposes the numbered pipeline roots", () => {
    expect(pipelineRoots).toEqual([
      "01-evidence-ingestion",
      "02-search",
      "03-match",
      "04-application-preparation",
    ]);
  });

  it("declares every model call exactly once", () => {
    const ids = llmCallCatalog.map((call) => call.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "evidence.chunk-analysis",
      "evidence.chunk-coverage",
      "evidence.chunk-repair",
      "evidence.synthesis",
      "search.web-discovery",
      "search.source-navigation",
      "search.listing-extraction",
      "search.vacancy-verification",
      "match.requirements",
      "match.tier2-evidence",
      "match.verification",
      "match.repair",
      "application.navigate",
      "application.field-map",
      "application.schema-verify",
      "application.company-research",
      "application.draft",
      "application.verify",
      "application.repair",
      "application.cover-letter-refine",
      "application.answer-refine",
      "application.cv-tailor",
    ]);
  });

  it("makes every LLM boundary inspectable", () => {
    for (const call of llmCallCatalog) {
      expect(call.rolePrompt.trim().length).toBeGreaterThan(80);
      expect(call.input.trim()).not.toBe("");
      expect(call.output.trim()).not.toBe("");
      expect(call.command.role.trim()).not.toBe("");
      expect(call.command.approvalPolicy).toBe("never");
      expect(call.memory.reads.length).toBeGreaterThan(0);
      expect(call.memory.writes).toContain("Codex run trace");
      expect(call.verification.length).toBeGreaterThan(0);
    }
  });

  it("keeps role prompts small and puts procedures in explicit skills", async () => {
    for (const call of llmCallCatalog) {
      const roleWords = wordCount(call.rolePrompt);
      expect(roleWords, `${call.id} role prompt minimum`).toBeGreaterThanOrEqual(35);
      expect(roleWords, `${call.id} role prompt maximum`).toBeLessThanOrEqual(80);
      expect(call.rolePrompt, call.id).toContain("You are");
      expect(call.rolePrompt, call.id).toContain("Follow the assigned skill");
      expect(call.rolePrompt, call.id).toContain("Return only structured JSON");

      const skillName =
        LLM_CALL_SKILLS[call.id as keyof typeof LLM_CALL_SKILLS];
      const skill = await readFile(
        path.resolve(".agents/skills", skillName, "SKILL.md"),
        "utf8",
      );
      expect(skill, `${call.id} procedure`).toContain("## Procedure");
      expect(skill, `${call.id} decision rules`).toContain("## Decision rules");
      expect(wordCount(skill), `${call.id} detailed skill`).toBeGreaterThan(180);
      expect(wordCount(skill), `${call.id} skill exceeds role`).toBeGreaterThan(
        roleWords * 2,
      );
    }
  });

  it("gives every LLM call one official skill and one deterministic gateway", async () => {
    const catalogIds = llmCallCatalog.map((call) => call.id).sort();
    expect([...RESULT_GATEWAY_CALL_IDS].sort()).toEqual(catalogIds);
    expect(Object.keys(LLM_CALL_SKILLS).sort()).toEqual(catalogIds);

    for (const [callId, skillName] of Object.entries(LLM_CALL_SKILLS)) {
      const skillRoot = path.resolve(".agents/skills", skillName);
      const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
      const metadata = await readFile(
        path.join(skillRoot, "agents/openai.yaml"),
        "utf8",
      );
      expect(skill, callId).toContain(`name: ${skillName}`);
      expect(skill, callId).not.toContain("TODO");
      expect(metadata, callId).toContain("allow_implicit_invocation: false");
    }
  });

  it("allows live web search only in vacancy discovery and application-stage company research", () => {
    for (const call of llmCallCatalog) {
      if (
        call.id === "search.web-discovery" ||
        call.id === "application.company-research"
      ) {
        expect(call.tools.allowed).toEqual(["web_search"]);
        expect(call.command.webSearch).toBe("live");
      } else {
        expect(call.tools.allowed).toEqual([]);
        expect(call.command.webSearch).toBe("disabled");
      }
    }
  });

  it("keeps pipelines independent from delivery and orchestration layers", async () => {
    for (const pipeline of pipelineRoots) {
      const files = await sourceFiles(path.resolve("src", pipeline));
      for (const file of files) {
        const source = await readFile(file, "utf8");
        expect(source).not.toMatch(/from\s+["'][^"']*(?:backend|server|ui)\//);
      }
    }
  });

  it("keeps CLI scripts on production entry points", async () => {
    const files = await sourceFiles(path.resolve("scripts"));
    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source).not.toMatch(/from\s+["'][^"']*tests\//);
    }
  });

  it("keeps every product LLM boundary inside a pipeline", async () => {
    const src = path.resolve("src");
    const files = await sourceFiles(src);
    const modelCallFiles: string[] = [];
    const callIds: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (!source.includes(".startThread(")) continue;
      if (file.endsWith("/codex-runtime/client.ts")) continue;
      modelCallFiles.push(path.relative(src, file).replaceAll(path.sep, "/"));
      callIds.push(
        ...[...source.matchAll(/callId:\s*"([^"]+)"/g)].map(
          (match) => match[1],
        ),
      );
    }
    expect(
      modelCallFiles.every((file) =>
        modelBoundaryRoots.some((pipeline) => file.startsWith(`${pipeline}/`)),
      ),
    ).toBe(true);
    expect(new Set(callIds)).toEqual(
      new Set(llmCallCatalog.map((call) => call.id)),
    );
  });

  it("fans matching work out with a bound and joins in job order", async () => {
    const jobs = [0, 1, 2, 3, 4, 5];
    let active = 0;
    let maximumActive = 0;
    const results = await mapParallelOrdered(jobs, 3, async (job) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, (jobs.length - job) % 4));
      active -= 1;
      return `job-${job}`;
    });
    expect(maximumActive).toBe(3);
    expect(results).toEqual(jobs.map((job) => `job-${job}`));
  });
});

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const target = path.join(directory, entry.name);
        return entry.isDirectory()
          ? sourceFiles(target)
          : Promise.resolve(/\.(?:ts|tsx|js)$/.test(entry.name) ? [target] : []);
      }),
    )
  ).flat();
}

async function llmCallDirectories(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = new Set(
    entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
  );
  if (files.has("index.ts") && directory.split(path.sep).includes("llm-calls"))
    return [directory];
  return (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => llmCallDirectories(path.join(directory, entry.name))),
    )
  ).flat();
}

function wordCount(value: string) {
  return value.trim().split(/\s+/).filter(Boolean).length;
}
