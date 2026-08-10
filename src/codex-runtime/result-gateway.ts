import Ajv, { type ErrorObject } from "ajv";

type JsonObject = Record<string, unknown>;

export interface ResultGatewayDefect {
  code: string;
  path: string;
  message: string;
  expected?: unknown;
  received?: unknown;
}

export interface ResultGatewayReport {
  accepted: boolean;
  callId: string;
  checks: string[];
  defects: ResultGatewayDefect[];
  adjustments: ResultGatewayAdjustment[];
  evaluatedAt: string;
}

export interface ResultGatewayAdjustment {
  code: string;
  path: string;
  message: string;
  before: unknown;
  after: unknown;
}

export interface ResultGatewayEvaluation {
  report: ResultGatewayReport;
  output?: unknown;
}

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  validateFormats: false,
});

export const RESULT_GATEWAY_CALL_IDS = [
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
] as const;

const registeredCallIds = new Set<string>(RESULT_GATEWAY_CALL_IDS);

const EXACT_SOURCE_KEYS: Record<string, ReadonlySet<string>> = {
  "evidence.chunk-analysis": new Set(["quote"]),
  "evidence.chunk-coverage": new Set(["quote"]),
  "evidence.chunk-repair": new Set(["quote"]),
  "evidence.synthesis": new Set(["quote"]),
  "search.listing-extraction": new Set(["sourceText"]),
  "search.vacancy-verification": new Set(["sourceText"]),
  "match.requirements": new Set(["excerpt"]),
  "match.tier2-evidence": new Set(["excerpt"]),
  "match.repair": new Set(["excerpt"]),
};

export function evaluateResultGateway(input: {
  callId: string;
  finalText: string;
  outputSchema?: JsonObject;
  prompt: string;
}): ResultGatewayEvaluation {
  const checks = ["json-parse", "safe-object-keys"];
  const defects: ResultGatewayDefect[] = [];
  const adjustments: ResultGatewayAdjustment[] = [];
  let output: unknown;

  try {
    output = JSON.parse(input.finalText);
  } catch (error) {
    defects.push({
      code: "INVALID_JSON",
      path: "$",
      message: error instanceof Error ? error.message : "Result is not valid JSON",
      expected: "One JSON value",
      received: input.finalText.slice(0, 500),
    });
    return completed(input.callId, checks, defects, adjustments);
  }

  rejectUnsafeObjectKeys(output, "$", defects);

  checks.push("registered-call");
  if (!registeredCallIds.has(input.callId))
    defects.push({
      code: "UNREGISTERED_LLM_CALL",
      path: "$",
      message: "Every product LLM call must have an explicit deterministic gateway registration",
      received: input.callId,
    });

  if (input.outputSchema) {
    checks.push("json-schema");
    const validate = ajv.compile(input.outputSchema);
    if (!validate(output))
      defects.push(...(validate.errors || []).map(schemaDefect));
  }

  if (input.callId === "search.web-discovery") {
    checks.push("duplicate-normalization");
    sanitizeDuplicateRows(output, "jobs", "jobUrl", adjustments);
    sanitizeDuplicateRows(output, "jobs", "url", adjustments);
  }

  if (input.callId === "evidence.chunk-coverage") {
    checks.push("finding-identity-normalization");
    normalizeDuplicateIdentities(
      output,
      "missingEvidence",
      "findingId",
      adjustments,
    );
  }

  if (
    input.callId === "search.web-discovery" ||
    input.callId === "search.listing-extraction" ||
    input.callId === "search.vacancy-verification"
  ) {
    checks.push("application-url-normalization");
    sanitizeSearchApplicationUrls(input.callId, output, adjustments);
  }

  const exactKeys = EXACT_SOURCE_KEYS[input.callId];
  if (exactKeys) {
    checks.push("exact-source-grounding");
    const sources = sourceCandidates(input.prompt);
    if (
      input.callId === "match.requirements" ||
      input.callId === "match.tier2-evidence" ||
      input.callId === "match.repair"
    ) {
      sanitizeContainedExcerptGrounding(output, sources, adjustments);
      sanitizeMatchedAssessmentState(output, adjustments);
    }
    if (input.callId === "evidence.chunk-analysis")
      sanitizeChunkAnalysisGrounding(output, sources, adjustments);
    if (input.callId === "evidence.chunk-coverage")
      sanitizeChunkCoverageGrounding(output, sources, adjustments);
    if (input.callId === "evidence.chunk-repair") {
      if (isObject(output))
        sanitizeChunkAnalysisGrounding(
          output.additions,
          sources,
          adjustments,
        );
      sanitizeChunkRepairReferences(output, adjustments);
    }
    validateExactSourceStrings(
      output,
      "$",
      exactKeys,
      sources,
      defects,
      adjustments,
    );
  }

  checks.push("call-specific-invariants");
  validateCallSpecificInvariants(input.callId, output, defects);

  return completed(input.callId, checks, defects, adjustments, output);
}

export class ResultGatewayError extends Error {
  constructor(public readonly report: ResultGatewayReport) {
    super(
      `Deterministic result gateway rejected ${report.callId}: ${report.defects
        .map((defect) => `${defect.code} at ${defect.path}: ${defect.message}`)
        .join("; ")}`,
    );
    this.name = "ResultGatewayError";
  }
}

function completed(
  callId: string,
  checks: string[],
  defects: ResultGatewayDefect[],
  adjustments: ResultGatewayAdjustment[],
  output?: unknown,
): ResultGatewayEvaluation {
  return {
    report: {
      accepted: defects.length === 0,
      callId,
      checks,
      defects,
      adjustments,
      evaluatedAt: new Date().toISOString(),
    },
    output,
  };
}

function schemaDefect(error: ErrorObject): ResultGatewayDefect {
  return {
    code: "SCHEMA_MISMATCH",
    path: error.instancePath ? `$${error.instancePath}` : "$",
    message: error.message || "Output does not satisfy its JSON Schema",
    expected: error.params,
  };
}

function rejectUnsafeObjectKeys(
  value: unknown,
  path: string,
  defects: ResultGatewayDefect[],
) {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      rejectUnsafeObjectKeys(item, `${path}[${index}]`, defects),
    );
    return;
  }
  if (!isObject(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor")
      defects.push({
        code: "UNSAFE_OBJECT_KEY",
        path: `${path}.${key}`,
        message: "Prototype-affecting keys are not accepted from model output",
      });
    rejectUnsafeObjectKeys(nested, `${path}.${key}`, defects);
  }
}

function validateExactSourceStrings(
  value: unknown,
  path: string,
  keys: ReadonlySet<string>,
  sources: string[],
  defects: ResultGatewayDefect[],
  adjustments: ResultGatewayAdjustment[],
) {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      validateExactSourceStrings(
        item,
        `${path}[${index}]`,
        keys,
        sources,
        defects,
        adjustments,
      ),
    );
    return;
  }
  if (!isObject(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const nestedPath = `${path}.${key}`;
    if (keys.has(key) && typeof nested === "string" && nested.trim()) {
      const exact = sources.some((source) => source.includes(nested));
      const aligned = exact
        ? undefined
        : sources.map((source) => alignSourceWhitespace(source, nested)).find(Boolean);
      if (aligned) {
        value[key] = aligned;
        adjustments.push({
          code: "SOURCE_WHITESPACE_ALIGNED",
          path: nestedPath,
          message: "Replaced whitespace-normalized model text with the exact supplied source span",
          before: nested,
          after: aligned,
        });
      } else if (!exact)
        defects.push({
          code: "SOURCE_TEXT_NOT_IN_INPUT",
          path: nestedPath,
          message: `${key} is not an exact substring of the supplied input`,
          expected: "Verbatim source text present in the call input",
          received: nested,
        });
    }
    validateExactSourceStrings(
      value[key],
      nestedPath,
      keys,
      sources,
      defects,
      adjustments,
    );
  }
}

function sanitizeContainedExcerptGrounding(
  output: unknown,
  sources: string[],
  adjustments: ResultGatewayAdjustment[],
) {
  visitObjects(output, "$", (item, path) => {
    const excerpt = item.excerpt;
    if (
      typeof excerpt !== "string" ||
      !excerpt.trim() ||
      sources.some((source) => source.includes(excerpt))
    )
      return;
    const replacement = sources
      .filter((source) => source.length >= 20 && excerpt.includes(source))
      .sort((left, right) => right.length - left.length)[0];
    if (!replacement) return;
    adjustments.push({
      code: "CONTAINED_EXCERPT_ALIGNED",
      path: `${path}.excerpt`,
      message:
        "Replaced a concatenated match evidence excerpt with the longest exact supplied source span it contained",
      before: excerpt,
      after: replacement,
    });
    item.excerpt = replacement;
  });
}

function sanitizeMatchedAssessmentState(
  output: unknown,
  adjustments: ResultGatewayAdjustment[],
) {
  for (const [assessment, path] of assessmentObjects(output)) {
    if (!Array.isArray(assessment.requirements)) continue;
    assessment.requirements.forEach((row, index) => {
      if (
        !isObject(row) ||
        row.status !== "matched" ||
        row.gapSeverity === undefined ||
        row.gapSeverity === "none"
      )
        return;
      adjustments.push({
        code: "MATCHED_GAP_SEVERITY_ALIGNED",
        path: `${path}.requirements[${index}].gapSeverity`,
        message:
          "Set gapSeverity to none for a row that the model classified as matched",
        before: row.gapSeverity,
        after: "none",
      });
      row.gapSeverity = "none";
    });
  }
}

function assessmentObjects(output: unknown) {
  if (!isObject(output)) return [];
  if (Array.isArray(output.assessments)) {
    const assessments: Array<readonly [Record<string, unknown>, string]> = [];
    output.assessments.forEach((item, index) => {
      if (isObject(item)) assessments.push([item, `$.assessments[${index}]`]);
    });
    return assessments;
  }
  return [[output, "$"] as const];
}

function visitObjects(
  value: unknown,
  path: string,
  visitor: (item: Record<string, unknown>, path: string) => void,
) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitObjects(item, `${path}[${index}]`, visitor));
    return;
  }
  if (!isObject(value)) return;
  visitor(value, path);
  for (const [key, nested] of Object.entries(value))
    visitObjects(nested, `${path}.${key}`, visitor);
}

function sanitizeChunkAnalysisGrounding(
  output: unknown,
  sources: string[],
  adjustments: ResultGatewayAdjustment[],
) {
  if (!isObject(output)) return;
  if (Array.isArray(output.profileFacts))
    output.profileFacts = output.profileFacts.filter((item, index) =>
      keepGroundedEvidenceItem(
        item,
        sources,
        `$.profileFacts[${index}]`,
        adjustments,
      ),
    );
  if (Array.isArray(output.profileEvidence))
    output.profileEvidence = output.profileEvidence.filter((item, index) =>
      keepGroundedEvidenceItem(
        item,
        sources,
        `$.profileEvidence[${index}]`,
        adjustments,
      ),
    );
  if (Array.isArray(output.profileFacts))
    output.profileFacts = output.profileFacts.filter((item, index) =>
      keepGroundedEvidenceItem(
        item,
        sources,
        `$.profileFacts[${index}]`,
        adjustments,
      ),
    );
  if (!Array.isArray(output.claims)) return;
  output.claims = output.claims.filter((claim, claimIndex) => {
    if (!isObject(claim)) return true;
    if (
      typeof claim.quote === "string" &&
      claim.quote.trim() &&
      !isGroundedSourceText(claim.quote, sources)
    ) {
      adjustments.push({
        code: "UNGROUNDED_CLAIM_DROPPED",
        path: `$.claims[${claimIndex}]`,
        message:
          "Dropped a chunk-reader claim whose quotation failed exact-source validation",
        before: claim,
        after: undefined,
      });
      return false;
    }
    if (!Array.isArray(claim.sourceEvidence)) return true;
    const groundedEvidence = claim.sourceEvidence.filter((item, evidenceIndex) =>
      keepGroundedEvidenceItem(
        item,
        sources,
        `$.claims[${claimIndex}].sourceEvidence[${evidenceIndex}]`,
        adjustments,
      ),
    );
    claim.sourceEvidence = groundedEvidence;
    if (groundedEvidence.length > 0) return true;
    adjustments.push({
      code: "UNGROUNDED_CLAIM_DROPPED",
      path: `$.claims[${claimIndex}]`,
      message:
        "Dropped a chunk-reader claim after all of its source quotations failed exact-source validation",
      before: claim,
      after: undefined,
    });
    return false;
  });
}

function sanitizeChunkCoverageGrounding(
  output: unknown,
  sources: string[],
  adjustments: ResultGatewayAdjustment[],
) {
  if (!isObject(output) || !Array.isArray(output.missingEvidence)) return;
  const groundedFindings = output.missingEvidence.filter((item, index) => {
    if (!isObject(item) || typeof item.quote !== "string" || !item.quote.trim())
      return true;
    const quote = item.quote;
    if (
      sources.some(
        (source) =>
          source.includes(quote) || Boolean(alignSourceWhitespace(source, quote)),
      )
    )
      return true;
    adjustments.push({
      code: "UNGROUNDED_COVERAGE_FINDING_DROPPED",
      path: `$.missingEvidence[${index}]`,
      message:
        "Dropped one coverage finding whose supporting quotation was not present in the supplied source chunk; the incomplete verdict remains unchanged",
      before: item,
      after: undefined,
    });
    return false;
  });
  output.missingEvidence = groundedFindings;
  const blocking = groundedFindings.some(
    (finding) => isObject(finding) && finding.severity === "blocking",
  );
  const hasUnsupported = asArray(output.unsupportedExtractions).length > 0;
  if (output.complete === true && (blocking || hasUnsupported)) {
    adjustments.push({
      code: "COVERAGE_VERDICT_CORRECTED",
      path: "$.complete",
      message:
        "Changed a contradictory complete verdict to incomplete while preserving all blocking and unsupported findings",
      before: true,
      after: false,
    });
    output.complete = false;
  }
}

function sanitizeChunkRepairReferences(
  output: unknown,
  adjustments: ResultGatewayAdjustment[],
) {
  if (!isObject(output) || !Array.isArray(output.removals)) return;
  const resolutions = new Set(
    asArray(output.resolutions)
      .filter(isObject)
      .map((item) => item.findingId)
      .filter((value): value is string => typeof value === "string"),
  );
  output.removals = output.removals.filter((removal, index) => {
    if (
      !isObject(removal) ||
      typeof removal.findingId !== "string" ||
      resolutions.has(removal.findingId)
    )
      return true;
    adjustments.push({
      code: "ORPHANED_REPAIR_REMOVAL_DROPPED",
      path: `$.removals[${index}]`,
      message:
        "Dropped one removal that had no corresponding finding resolution; unresolved removals are not applied",
      before: removal,
      after: undefined,
    });
    return false;
  });
}

function keepGroundedEvidenceItem(
  item: unknown,
  sources: string[],
  path: string,
  adjustments: ResultGatewayAdjustment[],
) {
  if (!isObject(item) || typeof item.quote !== "string" || !item.quote.trim())
    return true;
  const quote = item.quote;
  if (isGroundedSourceText(quote, sources)) return true;
  adjustments.push({
    code: "UNGROUNDED_EVIDENCE_DROPPED",
    path,
    message:
      "Dropped one chunk-reader evidence item whose quotation was not present in the supplied source chunk",
    before: item,
    after: undefined,
  });
  return false;
}

function isGroundedSourceText(value: string, sources: string[]) {
  return sources.some(
    (source) =>
      source.includes(value) || Boolean(alignSourceWhitespace(source, value)),
  );
}

function sourceCandidates(prompt: string) {
  const values = [prompt];
  for (const match of prompt.matchAll(/"(?:\\.|[^"\\])*"/gs)) {
    try {
      const decoded = JSON.parse(match[0]);
      if (typeof decoded === "string" && decoded.length > 0) values.push(decoded);
    } catch {
      // Ignore partial or non-JSON string literals in prose.
    }
  }
  return [...new Set(values)];
}

function alignSourceWhitespace(source: string, candidate: string) {
  const normalizedSource = normalizeWithSourceMap(source);
  const normalizedCandidate = normalizeWithSourceMap(candidate).text.trim();
  if (!normalizedCandidate) return undefined;
  const start = normalizedSource.text.indexOf(normalizedCandidate);
  if (start < 0) return undefined;
  const end = start + normalizedCandidate.length - 1;
  const sourceStart = normalizedSource.map[start];
  const sourceEnd = normalizedSource.map[end];
  if (sourceStart === undefined || sourceEnd === undefined) return undefined;
  return source.slice(sourceStart, sourceEnd + 1);
}

function normalizeWithSourceMap(value: string) {
  let text = "";
  const map: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (/\s/.test(character)) {
      const whitespaceStart = index;
      while (index + 1 < value.length && /\s/.test(value[index + 1])) index += 1;
      if (text.endsWith("-")) continue;
      if (text && !text.endsWith(" ")) {
        text += " ";
        map.push(whitespaceStart);
      }
      continue;
    }
    text += character;
    map.push(index);
  }
  return { text: text.trim(), map };
}

function validateCallSpecificInvariants(
  callId: string,
  output: unknown,
  defects: ResultGatewayDefect[],
) {
  const root = isObject(output) ? output : {};
  switch (callId) {
    case "evidence.chunk-analysis":
      uniqueValues(root.insights, "id", "$.insights", defects);
      uniqueValues(root.claims, "id", "$.claims", defects);
      break;
    case "evidence.chunk-coverage": {
      uniqueValues(root.missingEvidence, "findingId", "$.missingEvidence", defects);
      const blocking = asArray(root.missingEvidence).some(
        (finding) => isObject(finding) && finding.severity === "blocking",
      );
      if (root.complete === true && (blocking || asArray(root.unsupportedExtractions).length))
        defects.push({
          code: "INCONSISTENT_VERDICT",
          path: "$.complete",
          message: "Coverage cannot be complete while blocking or unsupported findings exist",
        });
      break;
    }
    case "evidence.chunk-repair":
      uniqueValues(root.resolutions, "findingId", "$.resolutions", defects);
      validateRepairReferences(root, defects);
      break;
    case "search.web-discovery":
      uniqueValues(root.jobs, "jobUrl", "$.jobs", defects);
      uniqueValues(root.jobs, "url", "$.jobs", defects);
      validateHttpUrls(
        root.jobs,
        ["jobUrl", "url", "applyUrl"],
        "$.jobs",
        defects,
      );
      break;
    case "search.listing-extraction":
      uniqueValues(root.jobs, "jobUrl", "$.jobs", defects);
      validateHttpUrls(root.jobs, ["jobUrl", "applyUrl"], "$.jobs", defects);
      break;
    case "search.vacancy-verification": {
      const rows = Array.isArray(root.results) ? root.results : [root];
      if (Array.isArray(root.results))
        uniqueValues(root.results, "id", "$.results", defects);
      validateHttpUrls(
        rows,
        ["applyUrl"],
        Array.isArray(root.results) ? "$.results" : "$",
        defects,
        true,
      );
      break;
    }
    case "search.source-navigation":
      validateNavigationDecision(root, true, defects);
      break;
    case "application.navigate":
      validateNavigationDecision(root, false, defects);
      break;
    case "application.field-map":
      uniqueValues(root.fields, "fieldId", "$.fields", defects);
      break;
    case "application.schema-verify":
      uniqueStrings(root.issues, "$.issues", defects);
      break;
    case "application.company-research":
      uniqueValues(root.sources, "url", "$.sources", defects);
      validateHttpUrls(root.sources, ["url"], "$.sources", defects);
      break;
    case "match.requirements":
    case "match.tier2-evidence":
    case "match.repair":
      validateAssessmentRows([root], defects, "$");
      break;
    case "match.verification":
      validateVerificationRows([root], defects, "$");
      break;
    case "application.draft":
    case "application.repair":
      uniqueValues(root.drafts, "applicationId", "$.drafts", defects);
      for (const [index, draft] of asArray(root.drafts).entries())
        if (isObject(draft))
          uniqueValues(draft.answers, "fieldId", `$.drafts[${index}].answers`, defects);
      break;
    case "application.verify":
      uniqueValues(root.verifications, "applicationId", "$.verifications", defects);
      validateVerificationRows(root.verifications, defects);
      break;
    default:
      break;
  }
}

function validateRepairReferences(root: JsonObject, defects: ResultGatewayDefect[]) {
  const resolutions = new Set(
    asArray(root.resolutions)
      .filter(isObject)
      .map((item) => item.findingId)
      .filter((value): value is string => typeof value === "string"),
  );
  asArray(root.removals).forEach((removal, index) => {
    if (
      isObject(removal) &&
      typeof removal.findingId === "string" &&
      !resolutions.has(removal.findingId)
    )
      defects.push({
        code: "UNRESOLVED_REPAIR_REFERENCE",
        path: `$.removals[${index}].findingId`,
        message: "Every removal must have a corresponding finding resolution",
        received: removal.findingId,
      });
  });
}

function validateNavigationDecision(
  root: JsonObject,
  hasCompletion: boolean,
  defects: ResultGatewayDefect[],
) {
  const action = root.action;
  if (action === "click" && !nonEmptyString(root.controlId))
    defects.push({
      code: "MISSING_CONTROL_ID",
      path: "$.controlId",
      message: "A click action requires a concrete observed control id",
    });
  if (action !== "click" && nonEmptyString(root.controlId))
    defects.push({
      code: "UNEXPECTED_CONTROL_ID",
      path: "$.controlId",
      message: "Only click actions may name a control id",
      received: root.controlId,
    });
  if (!hasCompletion) return;
  if (action === "stop" && root.completion === "continue")
    defects.push({
      code: "INCONSISTENT_NAVIGATION_STATE",
      path: "$.completion",
      message: "A stop action cannot request continuation",
    });
  if (action !== "stop" && root.completion !== "continue")
    defects.push({
      code: "INCONSISTENT_NAVIGATION_STATE",
      path: "$.completion",
      message: "A non-stop action must continue navigation",
      received: root.completion,
    });
}

function validateAssessmentRows(
  value: unknown,
  defects: ResultGatewayDefect[],
  basePath = "$.assessments",
) {
  asArray(value).forEach((assessment, assessmentIndex) => {
    if (!isObject(assessment)) return;
    const seen = new Set<string>();
    asArray(assessment.requirements).forEach((row, rowIndex) => {
      if (!isObject(row) || typeof row.requirement !== "string") return;
      const key = row.requirement.trim().toLowerCase();
      if (!key) return;
      if (seen.has(key))
        defects.push({
          code: "DUPLICATE_REQUIREMENT",
          path: `${basePath === "$" ? "$" : `${basePath}[${assessmentIndex}]`}.requirements[${rowIndex}].requirement`,
          message: "A requirement may appear only once in one assessment",
          received: row.requirement,
        });
      seen.add(key);
      if (row.status === "matched" && row.gapSeverity !== "none")
        defects.push({
          code: "INCONSISTENT_MATCH_STATE",
          path: `${basePath === "$" ? "$" : `${basePath}[${assessmentIndex}]`}.requirements[${rowIndex}]`,
          message: "A matched requirement cannot retain a material gap severity",
        });
    });
  });
}

function validateVerificationRows(
  value: unknown,
  defects: ResultGatewayDefect[],
  basePath = "$.verifications",
) {
  asArray(value).forEach((row, index) => {
    if (!isObject(row)) return;
    const findings = asArray(row.findings);
    const repairs = asArray(row.repairInstructions);
    if (row.verdict === "pass" && (findings.length || repairs.length))
      defects.push({
        code: "INCONSISTENT_VERIFICATION_VERDICT",
        path: `${basePath === "$" ? "$" : `${basePath}[${index}]`}.verdict`,
        message: "A passing verification cannot contain repair findings or instructions",
      });
    if (row.verdict === "needs_repair" && findings.length === 0)
      defects.push({
        code: "MISSING_REPAIR_FINDING",
        path: `${basePath === "$" ? "$" : `${basePath}[${index}]`}.findings`,
        message: "A needs_repair verdict must identify at least one concrete defect",
      });
  });
}

function uniqueValues(
  value: unknown,
  key: string,
  path: string,
  defects: ResultGatewayDefect[],
) {
  const seen = new Set<string>();
  asArray(value).forEach((item, index) => {
    if (!isObject(item) || typeof item[key] !== "string") return;
    const normalized = item[key].trim();
    if (!normalized) return;
    if (seen.has(normalized))
      defects.push({
        code: "DUPLICATE_IDENTITY",
        path: `${path}[${index}].${key}`,
        message: `${key} must be unique within the result`,
        received: item[key],
      });
    seen.add(normalized);
  });
}

function sanitizeDuplicateRows(
  output: unknown,
  collectionKey: string,
  identityKey: string,
  adjustments: ResultGatewayAdjustment[],
) {
  if (!isObject(output) || !Array.isArray(output[collectionKey])) return;
  const rows = output[collectionKey] as unknown[];
  const seen = new Set<string>();
  const retained: unknown[] = [];
  for (const [index, row] of rows.entries()) {
    if (!isObject(row) || typeof row[identityKey] !== "string") {
      retained.push(row);
      continue;
    }
    const identity = row[identityKey].trim();
    if (!identity || !seen.has(identity)) {
      if (identity) seen.add(identity);
      retained.push(row);
      continue;
    }
    adjustments.push({
      code: "DUPLICATE_RESULT_DROPPED",
      path: `$.${collectionKey}[${index}]`,
      message: `Dropped a duplicate ${identityKey} returned by discovery`,
      before: row,
      after: undefined,
    });
  }
  if (retained.length !== rows.length) output[collectionKey] = retained;
}

function normalizeDuplicateIdentities(
  output: unknown,
  collectionKey: string,
  identityKey: string,
  adjustments: ResultGatewayAdjustment[],
) {
  if (!isObject(output) || !Array.isArray(output[collectionKey])) return;
  const seen = new Set<string>();
  for (const [index, row] of output[collectionKey].entries()) {
    if (!isObject(row) || typeof row[identityKey] !== "string") continue;
    const identity = row[identityKey].trim();
    if (!identity || !seen.has(identity)) {
      if (identity) seen.add(identity);
      continue;
    }
    let suffix = 2;
    let replacement = `${identity}-${suffix}`;
    while (seen.has(replacement)) {
      suffix += 1;
      replacement = `${identity}-${suffix}`;
    }
    adjustments.push({
      code: "DUPLICATE_IDENTITY_RENAMED",
      path: `$.${collectionKey}[${index}].${identityKey}`,
      message:
        `Renamed a duplicate ${identityKey} so downstream repair references remain unambiguous`,
      before: row[identityKey],
      after: replacement,
    });
    row[identityKey] = replacement;
    seen.add(replacement);
  }
}

function uniqueStrings(value: unknown, path: string, defects: ResultGatewayDefect[]) {
  const seen = new Set<string>();
  asArray(value).forEach((item, index) => {
    if (typeof item !== "string" || !item.trim()) return;
    const normalized = item.trim().toLowerCase();
    if (seen.has(normalized))
      defects.push({
        code: "DUPLICATE_VALUE",
        path: `${path}[${index}]`,
        message: "Duplicate values are not accepted",
        received: item,
      });
    seen.add(normalized);
  });
}

function validateHttpUrls(
  value: unknown,
  keys: string[],
  path: string,
  defects: ResultGatewayDefect[],
  allowEmpty = false,
) {
  asArray(value).forEach((item, index) => {
    if (!isObject(item)) return;
    for (const key of keys) {
      const candidate = item[key];
      if (allowEmpty && candidate === "") continue;
      if (typeof candidate !== "string" || !candidate.trim()) continue;
      try {
        const url = new URL(candidate);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
      } catch {
        defects.push({
          code: "INVALID_PUBLIC_URL",
          path: `${path}[${index}].${key}`,
          message: "Expected an absolute HTTP(S) URL",
          received: candidate,
        });
      }
    }
  });
}

function sanitizeSearchApplicationUrls(
  callId: string,
  output: unknown,
  adjustments: ResultGatewayAdjustment[],
) {
  const root = isObject(output) ? output : undefined;
  if (!root) return;
  const batchedVerification =
    callId === "search.vacancy-verification" && Array.isArray(root.results);
  const rows = batchedVerification
    ? asArray(root.results).filter(isObject)
    : callId === "search.vacancy-verification"
      ? [root]
      : asArray(root.jobs).filter(isObject);
  rows.forEach((row, index) => {
    const applyUrl = row.applyUrl;
    if (typeof applyUrl !== "string" || !applyUrl.trim() || isPublicHttpUrl(applyUrl))
      return;
    const fallback =
      typeof row.jobUrl === "string" && isPublicHttpUrl(row.jobUrl)
        ? row.jobUrl.trim()
        : "";
    row.applyUrl = fallback;
    adjustments.push({
      code: "NON_HTTP_APPLY_URL_REPLACED",
      path:
        batchedVerification
          ? `$.results[${index}].applyUrl`
          : callId === "search.vacancy-verification"
          ? "$.applyUrl"
          : `$.jobs[${index}].applyUrl`,
      message: fallback
        ? "Kept the vacancy and replaced its non-web application action with the public vacancy page"
        : "Kept the vacancy interpretation but removed its non-web application action",
      before: applyUrl,
      after: fallback,
    });
  });
}

function isPublicHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
