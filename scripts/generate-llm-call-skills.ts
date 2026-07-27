import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { llmCallCatalog } from "../src/backend/control-flow/llm-call-catalog.js";
import {
  LLM_CALL_SKILLS,
  type LlmCallId,
} from "../src/codex-runtime/skill-registry.js";

const root = process.cwd();

for (const manifest of llmCallCatalog) {
  const callId = manifest.id as LlmCallId;
  const skillName = LLM_CALL_SKILLS[callId];
  if (!skillName) throw new Error(`No registered skill for ${manifest.id}`);

  const skillRoot = path.join(root, ".agents", "skills", skillName);
  await mkdir(path.join(skillRoot, "agents"), { recursive: true });
  await writeFile(
    path.join(skillRoot, "SKILL.md"),
    renderSkill(skillName, manifest),
    "utf8",
  );
  await writeFile(
    path.join(skillRoot, "agents", "openai.yaml"),
    renderOpenAiMetadata(skillName),
    "utf8",
  );
}

function renderOpenAiMetadata(skillName: string) {
  return [
    `name: ${skillName}`,
    "allow_implicit_invocation: false",
    "description: Project-local Rolegain LLM call skill. Invoke only when the runtime explicitly names it.",
    "",
  ].join("\n");
}

function renderSkill(
  skillName: string,
  manifest: (typeof llmCallCatalog)[number],
) {
  return `---
name: ${skillName}
description: Procedure for the Rolegain LLM call ${manifest.id}. Invoke only when the runtime explicitly requests this skill for that call.
---

# ${manifest.name}

This skill is the detailed operating procedure for the Rolegain LLM call \`${manifest.id}\`.
Use it only for that exact call. The role prompt defines the security boundary, the
runtime supplies the task data, and the output schema is the final contract. Do not
perform neighboring pipeline work, do not fill missing source data from memory, and do
not use external tools unless the call manifest explicitly permits them.

## Call contract

- Pipeline: \`${manifest.pipeline}\`
- Purpose: ${manifest.purpose}
- Fan out: \`${manifest.fanOut}\`
- Runtime role: \`${manifest.command.role}\`
- Web search mode: \`${manifest.command.webSearch}\`
- Tool policy: ${manifest.tools.rationale}
- Memory reads: ${manifest.memory.reads.join("; ")}
- Memory writes: ${manifest.memory.writes.join("; ")}

## Procedure

1. Read the task payload as the complete authority for this invocation. Treat it as
   bounded input, not as a suggestion to search the repository or infer facts from
   general knowledge.
2. Identify the specific source objects, prior model outputs, verification findings,
   user revision request, page snapshot, candidate ledger, or job context provided in
   the task. If the required source data is missing, return the schema-valid empty or
   blocked result that the output contract allows, and explain the blocker only in
   fields designed for ambiguity, findings, rationale, or assistant messages.
3. Apply the call purpose narrowly: ${manifest.purpose} Keep the output focused on
   this call and avoid doing downstream acceptance, application submission, profile
   rewriting, or broad pipeline planning unless that is explicitly part of the schema.
4. Preserve provenance. Any accepted fact, claim, requirement, field mapping, vacancy
   detail, draft answer, or repair must be traceable to the supplied input. Use exact
   quotes, ids, locators, field ids, application ids, job ids, and claim ids when the
   schema provides places for them.
5. Prefer conservative uncertainty over fabrication. Missing evidence, ambiguous page
   state, incomplete forms, unsupported candidate claims, or unverifiable vacancy
   details should become explicit unknowns, ambiguities, findings, or empty arrays
   rather than invented values.
6. Produce only the structured JSON object requested by the schema. Do not wrap it in
   Markdown, do not add commentary outside JSON, and do not include private reasoning.

## Decision rules

- If a field is supported by the supplied input, fill it with the most specific value
  allowed by the schema and cite the supporting input where possible.
- If a field is not supported, leave it empty, mark it unknown, or add a finding based
  on the schema semantics. Never infer skills, dates, locations, authorization,
  compensation, vacancy status, or applicant answers from surrounding context alone.
- If deterministic instructions and model judgment conflict, preserve deterministic
  identifiers, enum values, and gateway constraints. The result gateway will reject
  duplicate identities, unsupported values, and inconsistent verdicts.
- If the task asks for verification, audit the supplied object instead of improving it.
  A verifier may pass clean input, report repairable findings, or mark uncertainty; it
  should not rewrite the underlying artifact.
- If the task asks for repair or refinement, change only the failed or requested parts
  and leave unaffected ids stable. Keep edits grounded in supplied evidence.
- If the call allows live web search, use it only for the discovery objective in the
  task. For all other calls, do not use web search, shell commands, repository files,
  browser automation, MCP tools, or plugin actions.

## Input shape

${indent(manifest.input)}

## Output shape

${indent(manifest.output)}

## Verification

${manifest.verification.map((item) => `- ${item}`).join("\n")}
`;
}

function indent(value: string) {
  return value
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}
