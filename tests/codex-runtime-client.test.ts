import { describe, expect, it } from "vitest";
import {
  CodexExecClient,
  codexExecEventError,
  isPromptOnlyRole,
  llmCallToolViolation,
  loginStatusIsAuthenticated,
  promptOnlyToolViolation,
} from "../src/codex-runtime/client.js";

describe("prompt-only Codex roles", () => {
  it("does not mistake 'Not logged in' for an authenticated session", () => {
    expect(loginStatusIsAuthenticated("Logged in using ChatGPT")).toBe(true);
    expect(loginStatusIsAuthenticated("Not logged in")).toBe(false);
  });

  it("preserves JSONL runtime failures that Codex emits on stdout", () => {
    expect(codexExecEventError({
      type: "error",
      message: "invalid_json_schema: Missing startDate",
    })).toBe("invalid_json_schema: Missing startDate");
    expect(codexExecEventError({
      type: "turn.failed",
      error: { message: "request rejected" },
    })).toBe("request rejected");
    expect(codexExecEventError({ type: "turn.started" })).toBeUndefined();
  });

  it("gates every new thread while global background execution is stopped", async () => {
    const client = new CodexExecClient();
    await client.pauseAllTurns();
    await expect(
      client.startThread({
        cwd: process.cwd(),
        role: "test-worker",
        sandbox: "read-only",
        approvalPolicy: "never",
        developerInstructions: "Return JSON.",
      }),
    ).rejects.toThrow("Background execution is stopped");

    client.resumeTurns();
    await expect(
      client.startThread({
        cwd: process.cwd(),
        role: "test-worker",
        sandbox: "read-only",
        approvalPolicy: "never",
        developerInstructions: "Return JSON.",
      }),
    ).resolves.toMatchObject({ modelProvider: "openai" });
    await client.close();
  });

  it("marks every requirement-matching role as prompt-only", () => {
    expect(isPromptOnlyRole("job-requirement-assessor")).toBe(true);
    expect(isPromptOnlyRole("tier2-requirement-assessor")).toBe(true);
    expect(isPromptOnlyRole("independent-fit-verifier")).toBe(true);
    expect(isPromptOnlyRole("job-requirement-repairer")).toBe(true);
    expect(isPromptOnlyRole("candidate-source-reader")).toBe(true);
    expect(isPromptOnlyRole("candidate-source-coverage-verifier")).toBe(true);
    expect(isPromptOnlyRole("candidate-intelligence")).toBe(true);
    expect(isPromptOnlyRole("public-web-job-researcher")).toBe(false);
  });

  it("treats any unexpected shell event as a failed tool-boundary assertion", () => {
    const command = {
      type: "item.started",
      item: { type: "command_execution", command: "rg -n ''" },
    };
    expect(
      promptOnlyToolViolation("job-requirement-assessor", command),
    ).toContain("forbidden tool use (command_execution)");
    expect(
      promptOnlyToolViolation("job-requirement-assessor", {
        type: "item.started",
        item: { type: "web_search" },
      }),
    ).toContain("forbidden tool use (web_search)");
    expect(
      promptOnlyToolViolation("job-requirement-assessor", {
        type: "item.completed",
        item: { type: "agent_message" },
      }),
    ).toBeUndefined();
    expect(
      promptOnlyToolViolation("public-web-job-researcher", command),
    ).toBeUndefined();
    expect(
      promptOnlyToolViolation("candidate-source-reader", command),
    ).toContain("forbidden tool use (command_execution)");
    expect(
      promptOnlyToolViolation("candidate-source-reader", {
        type: "item.started",
        item: { type: "command_execution", command: "/bin/zsh -lc pwd" },
      }),
    ).toContain("forbidden tool use (command_execution)");
    expect(
      llmCallToolViolation("search.web-discovery", "public-web-job-researcher", {
        type: "item.started",
        item: { type: "web_search" },
      }),
    ).toBeUndefined();
    expect(
      llmCallToolViolation(
        "application.company-research",
        "application-company-researcher",
        {
          type: "item.started",
          item: { type: "web_search" },
        },
        true,
      ),
    ).toBeUndefined();
    expect(
      llmCallToolViolation(
        "application.company-research",
        "application-company-researcher",
        {
          type: "item.started",
          item: { type: "web_search" },
        },
        false,
      ),
    ).toContain("forbidden tool use (web_search)");
    expect(
      llmCallToolViolation("application.draft", "cover-letter-writer", command),
    ).toContain("LLM call application.draft");
  });
});
