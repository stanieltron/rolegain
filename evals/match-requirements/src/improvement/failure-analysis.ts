import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { matchRequirementsCorpus } from "../dataset/corpus.js";
import type { MatchEvalTrialResult } from "../harness/runner.js";

export interface EvalFailureAnalysis {
  runRoot: string;
  totalTrials: number;
  failedTrials: number;
  clusters: FailureCluster[];
  recommendedActions: RecommendedAction[];
}

export interface FailureCluster {
  key: string;
  count: number;
  suite: string;
  family: string;
  errorType: string;
  cases: string[];
  rowReasons: string[];
}

export interface RecommendedAction {
  priority: "high" | "medium" | "low";
  owner: "dataset" | "prompt-skill" | "schema-gateway" | "retrieval" | "verifier" | "repair";
  summary: string;
  cases: string[];
}

const familyByCase = new Map(matchRequirementsCorpus.map((item) => [item.id, item.family]));

export async function analyzeEvalFailures(runRoot: string): Promise<EvalFailureAnalysis> {
  const trials = await readTrials(runRoot);
  const failed = trials.filter((trial) => !trial.passed);
  const grouped = new Map<string, MatchEvalTrialResult[]>();
  for (const trial of failed) {
    const family = familyByCase.get(trial.caseId) || "unknown";
    const key = [
      trial.suite,
      family,
      trial.errorType || "semantic_failure",
    ].join("|");
    grouped.set(key, [...(grouped.get(key) || []), trial]);
  }
  const clusters = [...grouped.entries()]
    .map(([key, items]) => {
      const [suite, family, errorType] = key.split("|");
      return {
        key,
        count: items.length,
        suite,
        family,
        errorType,
        cases: [...new Set(items.map((item) => item.caseId))].sort(),
        rowReasons: topReasons(items),
      };
    })
    .sort((left, right) => right.count - left.count);
  const analysis = {
    runRoot: path.resolve(runRoot),
    totalTrials: trials.length,
    failedTrials: failed.length,
    clusters,
    recommendedActions: recommendActions(clusters),
  };
  await writeFile(
    path.join(runRoot, "failure-analysis.json"),
    `${JSON.stringify(analysis, null, 2)}\n`,
    "utf8",
  );
  return analysis;
}

async function readTrials(runRoot: string) {
  return (await readFile(path.join(runRoot, "trials.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MatchEvalTrialResult);
}

function topReasons(items: MatchEvalTrialResult[]) {
  const counts = new Map<string, number>();
  for (const item of items)
    for (const row of item.grade.rows)
      for (const reason of row.reasons)
        counts.set(reason, (counts.get(reason) || 0) + 1);
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([reason, count]) => `${count}x ${reason}`);
}

function recommendActions(clusters: FailureCluster[]): RecommendedAction[] {
  return clusters.slice(0, 10).map((cluster) => {
    if (cluster.errorType === "result_gateway")
      return action("high", "schema-gateway", "Tighten schema/gateway repair instructions for rejected structured output.", cluster);
    if (cluster.suite === "match.requirements.component")
      return action("high", "prompt-skill", "Update first-pass extraction/match guidance and rerun development split before full flow.", cluster);
    if (cluster.suite === "match.tier2.component")
      return action("medium", "retrieval", "Inspect Tier 2 document selection and evidence grounding for unresolved rows.", cluster);
    if (cluster.suite === "match.verification.component")
      return action("high", "verifier", "Tune verifier rubric against seeded clean/defect matrices.", cluster);
    if (cluster.suite === "match.repair.component")
      return action("high", "repair", "Adjust repair prompt/schema constraints using failed challenge traces.", cluster);
    return action("medium", "prompt-skill", "Inspect full-flow trace and decide whether the root cause is first-pass, Tier 2, verifier, or repair.", cluster);
  });
}

function action(
  priority: RecommendedAction["priority"],
  owner: RecommendedAction["owner"],
  summary: string,
  cluster: FailureCluster,
): RecommendedAction {
  return {
    priority,
    owner,
    summary,
    cases: cluster.cases,
  };
}
