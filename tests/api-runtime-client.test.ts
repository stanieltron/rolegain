import { mkdtemp, mkdir, cp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleClient } from "../src/api-runtime/client.js";
import { CodexExecClient } from "../src/codex-runtime/client.js";
import {
  configuredLlmTransport,
  createLlmClient,
} from "../src/llm-runtime/client.js";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("OpenAI-compatible LLM transport", () => {
  it("uses the existing call harness and result gateway", async () => {
    const root = await temporaryProjectWithAnswerSkill();
    const requests: Array<Record<string, unknown>> = [];
    vi.stubEnv("ROLEGAIN_API_KEY", "test-api-key");
    vi.stubEnv("ROLEGAIN_API_BASE_URL", "https://provider.example/v1");
    vi.stubEnv("ROLEGAIN_API_MODEL", "provider-fast-model");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            id: "response-1",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    value: "Grounded revised answer",
                    evidenceBasis: "Supplied CV",
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 120, completion_tokens: 20 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const client = new OpenAiCompatibleClient(root);
    const thread = await client.startThread({
      cwd: root,
      callId: "application.answer-refine",
      role: "application-answer-editor",
      sandbox: "read-only",
      developerInstructions: "SYSTEM ROLE",
      approvalPolicy: "never",
      webSearch: { mode: "disabled" },
    });
    const result = await client.runTurn({
      threadId: thread.id,
      prompt: "TASK DATA",
      cwd: root,
      sandbox: "readOnly",
      effort: "low",
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value", "evidenceBasis"],
        properties: {
          value: { type: "string" },
          evidenceBasis: { type: "string" },
        },
      },
    });

    expect(JSON.parse(result.finalText)).toEqual({
      value: "Grounded revised answer",
      evidenceBasis: "Supplied CV",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: "provider-fast-model",
      reasoning_effort: "low",
      messages: [
        {
          role: "system",
          content: expect.stringContaining("SYSTEM ROLE"),
        },
        { role: "user", content: "TASK DATA" },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { strict: true },
      },
    });
    expect(
      (requests[0].messages as Array<{ content: string }>)[0].content,
    ).toContain("Procedure");

    const runFiles = await findRunFiles(root, "run.json");
    const run = JSON.parse(await readFile(runFiles[0], "utf8"));
    expect(run).toMatchObject({
      provider: "openai-compatible-api",
      status: "completed",
      providerResponseId: "response-1",
    });
  });

  it("uses native Gemini Google Search before schema-bound synthesis", async () => {
    const root = await temporaryProjectWithAnswerSkill();
    const requests: Array<{
      url: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
    }> = [];
    vi.stubEnv("ROLEGAIN_API_KEY", "test-api-key");
    vi.stubEnv("ROLEGAIN_API_BASE_URL", "https://gemini.example/v1beta/openai");
    vi.stubEnv("ROLEGAIN_GEMINI_BASE_URL", "https://gemini.example/v1beta");
    vi.stubEnv("ROLEGAIN_API_MODEL", "gemini-2.5-flash");
    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(url),
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          body: JSON.parse(String(init?.body)),
        });
        if (String(url).includes(":generateContent"))
          return new Response(
            JSON.stringify({
              responseId: "search-response-1",
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: "Acme builds verified infrastructure. Source: https://acme.example/about",
                      },
                    ],
                  },
                  groundingMetadata: {
                    webSearchQueries: ["Acme infrastructure company"],
                    groundingChunks: [
                      {
                        web: {
                          title: "About Acme",
                          uri: "https://acme.example/about",
                        },
                      },
                    ],
                  },
                },
              ],
              usageMetadata: {
                promptTokenCount: 40,
                candidatesTokenCount: 15,
                totalTokenCount: 55,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        return new Response(
          JSON.stringify({
            id: "synthesis-response-1",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    value: "Grounded answer",
                    evidenceBasis: "https://acme.example/about",
                  }),
                },
              },
            ],
            usage: {
              prompt_tokens: 80,
              completion_tokens: 20,
              total_tokens: 100,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenAiCompatibleClient(root);
    const thread = await client.startThread({
      cwd: root,
      callId: "application.answer-refine",
      role: "application-answer-editor",
      sandbox: "read-only",
      developerInstructions: "SYSTEM ROLE",
      webSearch: { mode: "live" },
    });

    const result = await client.runTurn({
      threadId: thread.id,
      prompt: "Research Acme",
      cwd: root,
      sandbox: "readOnly",
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value", "evidenceBasis"],
        properties: {
          value: { type: "string" },
          evidenceBasis: { type: "string" },
        },
      },
    });

    expect(JSON.parse(result.finalText)).toEqual({
      value: "Grounded answer",
      evidenceBasis: "https://acme.example/about",
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      url: "https://gemini.example/v1beta/models/gemini-2.5-flash:generateContent",
      headers: { "x-goog-api-key": "test-api-key" },
      body: { tools: [{ googleSearch: {} }] },
    });
    expect(requests[1].url).toBe(
      "https://gemini.example/v1beta/openai/chat/completions",
    );
    expect(
      (
        requests[1].body.messages as Array<{
          role: string;
          content: string;
        }>
      )[1].content,
    ).toContain("https://acme.example/about");

    const runFiles = await findRunFiles(root, "run.json");
    const run = JSON.parse(await readFile(runFiles[0], "utf8"));
    expect(run).toMatchObject({
      provider: "gemini-google-search+openai-compatible-api",
      status: "completed",
      providerResponseId: "synthesis-response-1",
      usage: { total_tokens: 155 },
    });
  });

  it("selects only the configured transport", () => {
    vi.stubEnv("ROLEGAIN_LLM_TRANSPORT", "api");
    expect(configuredLlmTransport()).toBe("api");
    expect(createLlmClient()).toBeInstanceOf(OpenAiCompatibleClient);

    vi.stubEnv("ROLEGAIN_LLM_TRANSPORT", "codex");
    expect(createLlmClient()).toBeInstanceOf(CodexExecClient);

    vi.stubEnv("ROLEGAIN_LLM_TRANSPORT", "unknown");
    expect(() => configuredLlmTransport()).toThrow(
      "Unsupported ROLEGAIN_LLM_TRANSPORT",
    );
  });
});

async function temporaryProjectWithAnswerSkill() {
  const root = await mkdtemp(path.join(os.tmpdir(), "rolegain-api-runtime-"));
  roots.push(root);
  const relative = path.join(
    ".agents",
    "skills",
    "rolegain-refine-application-answer",
  );
  await mkdir(path.join(root, relative), { recursive: true });
  await cp(
    path.join(process.cwd(), relative, "SKILL.md"),
    path.join(root, relative, "SKILL.md"),
  );
  return root;
}

async function findRunFiles(root: string, name: string) {
  const runsRoot = path.join(root, ".agent-runtime", "runs");
  const entries = await import("node:fs/promises").then(({ readdir }) =>
    readdir(runsRoot, { withFileTypes: true }),
  );
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runsRoot, entry.name, name));
}
