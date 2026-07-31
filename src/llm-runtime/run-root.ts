import path from "node:path";

/**
 * Keeps normal development traces in the historical location while allowing
 * diagnostic launches to put every LLM artifact inside one isolated session.
 */
export function llmRunRoot(projectRoot: string) {
  const configured = process.env.ROLEGAIN_LLM_RUN_ROOT?.trim();
  return configured
    ? path.resolve(projectRoot, configured)
    : path.join(projectRoot, ".agent-runtime", "runs");
}
