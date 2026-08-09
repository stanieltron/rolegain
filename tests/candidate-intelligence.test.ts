import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CandidateAnalyzer } from "../src/01-evidence-ingestion/types.js";
import { CodexCandidateAnalyzer } from "../src/01-evidence-ingestion/evidence-ingestion.js";
import {
  chunkSource,
  mapConcurrentOrdered,
} from "../src/01-evidence-ingestion/v1/02-chunk-reader/index.js";
import type {
  StartThreadOptions,
  StartTurnOptions,
} from "../src/codex-runtime/client.js";
import { CodexExecClient } from "../src/codex-runtime/client.js";
import { JobSearchService } from "../src/backend/control-flow/service.js";

describe("candidate intelligence", () => {
  it("lets CV identity replace OAuth defaults but preserves later manual edits", async () => {
    const analyzer: CandidateAnalyzer = {
      analyze: async (workspace) => {
        const cv = workspace.sources.find((source) => source.kind === "cv")!;
        return {
          threadId: "thread-cv-identity",
          profile: {
            ...workspace.profile,
            name: "Stanislav Vozarik",
            email: "stanislav.vozarik@example.test",
          },
          profileEvidence: [
            {
              field: "name",
              value: "Stanislav Vozarik",
              sourceId: cv.id,
              locator: "lines 1-1",
              quote: "Stanislav Vozarik",
            },
            {
              field: "email",
              value: "stanislav.vozarik@example.test",
              sourceId: cv.id,
              locator: "lines 2-2",
              quote: "stanislav.vozarik@example.test",
            },
          ],
          sourceInsights: workspace.sources.map((source) => ({
            sourceId: source.id,
            knowledgeMarkdown: `Notes for ${source.name}`,
            insights: [],
          })),
        };
      },
    };
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-cv-identity-"));
    const service = new JobSearchService(root, analyzer);
    await service.initialize();
    await service.updateProfile(
      { name: "Stano V", email: "stano.v@example.test" },
      { deferEvidenceAnalysis: true, identityOrigin: "auth" },
    );
    await service.addSource({
      kind: "cv",
      name: "candidate-cv.txt",
      content: "Stanislav Vozarik\nstanislav.vozarik@example.test",
    });

    const fromCv = await service.analyzeCandidate();
    expect(fromCv.profile.name).toBe("Stanislav Vozarik");
    expect(fromCv.profile.email).toBe("stanislav.vozarik@example.test");
    expect(fromCv.profileFieldOrigins).toMatchObject({
      name: "cv",
      email: "cv",
    });

    await service.updateProfile({ name: "Stan Vozarik" });
    const afterManualEdit = await service.analyzeCandidate();
    expect(afterManualEdit.profile.name).toBe("Stan Vozarik");
    expect(afterManualEdit.profileFieldOrigins?.name).toBe("manual");
  });

  it("automatically ingests profile links first extracted from the CV", async () => {
    let analyzerRuns = 0;
    const acquiredProfileUrls: string[] = [];
    const analyzer: CandidateAnalyzer = {
      analyze: async (workspace) => {
        analyzerRuns += 1;
        const cv = workspace.sources.find((source) => source.kind === "cv")!;
        return {
          threadId: `thread-profile-links-${analyzerRuns}`,
          profile: {
            ...workspace.profile,
            github: "https://github.com/candidate",
            website: "https://candidate.example",
          },
          profileEvidence: [
            {
              field: "github",
              value: "https://github.com/candidate",
              sourceId: cv.id,
              locator: "GitHub line",
              quote: "GitHub: https://github.com/candidate",
            },
            {
              field: "website",
              value: "https://candidate.example",
              sourceId: cv.id,
              locator: "Website line",
              quote: "Website: https://candidate.example",
            },
          ],
          sourceInsights: workspace.sources.map((source) => ({
            sourceId: source.id,
            knowledgeMarkdown: `Notes for ${source.name}`,
            insights: [],
          })),
        };
      },
    };
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-cv-profile-links-"));
    const service = new JobSearchService(
      root,
      analyzer,
      undefined,
      undefined,
      async (input) => {
        acquiredProfileUrls.push(input.url || "");
        return {
          kind: input.kind,
          name: input.name,
          url: input.url,
          content: `Public evidence acquired from ${input.url}`,
          contentHash: `hash-${input.url}`,
        };
      },
    );
    await service.initialize();
    await service.addSource({
      kind: "cv",
      name: "candidate-cv.txt",
      content: [
        "Candidate Name",
        "candidate@example.test",
        "GitHub: https://github.com/candidate",
        "Website: https://candidate.example",
      ].join("\n"),
    });

    const result = await service.analyzeCandidate();

    expect(analyzerRuns).toBe(2);
    expect(acquiredProfileUrls).toEqual([
      "https://github.com/candidate",
      "https://candidate.example/",
    ]);
    expect(result.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profileField: "github",
          status: "ready",
          content: expect.stringContaining("github.com/candidate"),
        }),
        expect.objectContaining({
          profileField: "website",
          status: "ready",
          content: expect.stringContaining("candidate.example"),
        }),
      ]),
    );
    expect(result.intelligence.status).toBe("ready");
  });

  it("derives the GitHub contributor identity server-side for repository expansion", async () => {
    const acquired: Array<{
      includeGitHubContributions?: boolean;
      githubContributor?: string;
    }> = [];
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-github-contributions-"));
    const service = new JobSearchService(
      root,
      undefined,
      undefined,
      undefined,
      async (input) => {
        acquired.push({
          includeGitHubContributions: input.includeGitHubContributions,
          githubContributor: input.githubContributor,
        });
        return {
          kind: "repository",
          name: input.name,
          url: input.url,
          content: "Repository and attributed public contribution evidence.",
          contentHash: "repository-contribution-hash",
        };
      },
    );
    await service.initialize();
    await service.updateProfile(
      { github: "https://github.com/candidate" },
      { deferEvidenceAnalysis: true },
    );

    await service.addSource({
      kind: "repository",
      name: "organisation/project",
      url: "https://github.com/organisation/project",
      includeGitHubContributions: true,
    });

    expect(acquired).toContainEqual({
      includeGitHubContributions: true,
      githubContributor: "candidate",
    });
  });

  it("defers website acquisition until the worker analysis step", async () => {
    let reads = 0;
    const reader = async (input: { kind: "webpage"; name: string; url?: string }) => {
      reads += 1;
      return {
        kind: input.kind,
        name: input.name,
        url: input.url,
        content: "Page: Example\n\nDeep evidence from the rendered website.",
        contentHash: "rendered-site-hash",
      };
    };
    const analyzer: CandidateAnalyzer = {
      analyze: async (workspace) => ({
        threadId: "thread-deferred-url",
        profile: workspace.profile,
        sourceInsights: workspace.sources.map((source) => ({
          sourceId: source.id,
          knowledgeMarkdown: `Notes for ${source.name}`,
          insights: [],
        })),
      }),
    };
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-deferred-url-"));
    const service = new JobSearchService(
      root,
      analyzer,
      undefined,
      undefined,
      reader as never,
    );
    await service.initialize();

    const staged = await service.addSource(
      { kind: "webpage", name: "Example", url: "https://example.com" },
      undefined,
      { deferUrlAcquisition: true },
    );
    expect(reads).toBe(0);
    expect(staged.sources[0]).toMatchObject({
      status: "processing",
      content: "",
      analysisRequired: true,
    });

    const analyzed = await service.analyzeCandidate();
    expect(reads).toBe(1);
    expect(analyzed.sources[0].content).toContain("Deep evidence");
    expect(analyzed.sources[0].status).toBe("ready");
  });

  it("covers the complete source when splitting evidence into model-sized chunks", () => {
    const lines = Array.from(
      { length: 4_000 },
      (_, index) => `evidence-line-${index}: supported candidate fact ${index}`,
    );
    const chunks = chunkSource(lines.join("\n"), 8_000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const line of lines) expect(chunks.some((chunk) => chunk.includes(line))).toBe(true);
    expect(chunks.at(-1)).toContain(lines.at(-1));
  });

  it("reads chunks concurrently but returns them in deterministic source order", async () => {
    const items = Array.from({ length: 9 }, (_, index) => index);
    let active = 0;
    let maximumActive = 0;
    const results = await mapConcurrentOrdered(items, 3, async (item) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) =>
        setTimeout(resolve, ((items.length - item) % 3) + 1),
      );
      active -= 1;
      return `chunk-${item}`;
    });

    expect(maximumActive).toBe(3);
    expect(results).toEqual(items.map((item) => `chunk-${item}`));
  });

  it("uses per-call evidence models and always runs synthesis after chunk analysis", async () => {
    const roles: string[] = [];
    const models: string[] = [];
    const threadRoles = new Map<string, string>();
    const codex = {
      start: async () => ({
        available: true,
        binary: "codex",
        version: "test",
        compatible: true,
        authenticated: true,
        authMode: "chatgpt",
        model: "gpt-5.4",
        models: [],
      }),
      startThread: async (options: StartThreadOptions) => {
        roles.push(options.role);
        const id = `thread-${roles.length}`;
        threadRoles.set(id, options.role);
        return { id, modelProvider: "openai" };
      },
      runTurn: async (options: StartTurnOptions) => {
        models.push(options.model || "");
        const role = threadRoles.get(options.threadId);
        const reader = role === "candidate-source-reader";
        const coverage = role === "candidate-source-coverage-verifier";
        const sourceId = workspace.sources[0].id;
        const profileEvidence = [
          "name",
          "email",
          "location",
          "headline",
          "summary",
          "skills",
          "languages",
        ].map((field) => ({
          field,
          value:
            field === "name"
              ? "Nina Novak"
              : field === "email"
                ? "nina@example.test"
                : field === "location"
                  ? "Bratislava"
                  : field === "headline"
                    ? "Platform engineer"
                    : field === "summary"
                      ? "Builds reliable TypeScript systems."
                      : field === "skills"
                        ? "TypeScript"
                        : "English",
          sourceId,
          locator: "lines 1-3",
          quote: "Built a reliable TypeScript platform.",
        }));
        return {
          threadId: options.threadId,
          turnId: `turn-${role}`,
          status: "completed" as const,
          finalText: JSON.stringify(coverage ? {
            complete: true,
            missingEvidence: [],
            unsupportedExtractions: [],
            summary: "Complete",
          } : reader ? {
            profileFacts: {
              name: "Nina Novak",
              email: "nina@example.test",
              phone: "",
              location: "Bratislava",
              headline: "Platform engineer",
              summary: "Builds reliable TypeScript systems.",
              skills: ["TypeScript", "TypeScript"],
              languages: ["English"],
            },
            profileEvidence,
            insights: [
              {
                id: "insight-platform",
                title: "TypeScript platform",
                summary: "Built a reliable platform.",
                evidence: "Built a reliable TypeScript platform",
                skills: ["TypeScript"],
                category: "project",
              },
            ],
            detailedNotes:
              "## TypeScript platform\n\nBuilt a reliable TypeScript platform.",
            claims: [],
            unknowns: [],
            prohibitedInferences: [],
          } : {
            profile: {
              ...workspace.profile,
              name: "Nina Novak",
              email: "nina@example.test",
              location: "Bratislava",
              headline: "Platform engineer",
              summary: "Builds reliable TypeScript systems.",
              skills: ["TypeScript"],
              languages: ["English"],
            },
            profileEvidence,
            unknowns: [],
            contradictions: [],
            prohibitedInferences: [],
            roleFamilies: [],
            searchVocabulary: {
              titleAliases: [],
              evidenceIntersections: [],
              problemPhrases: [],
              toolsMethodsStandards: [],
              adjacentDialects: [],
              seniorityOwnershipModifiers: [],
              geographyLanguageVariants: [],
              negativeTerms: [],
            },
          }),
          items: [],
        };
      },
    } as unknown as CodexExecClient;
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-single-chunk-"));
    const service = new JobSearchService(root);
    await service.initialize();
    const workspace = await service.addSource({
      kind: "cv",
      name: "nina-cv.txt",
      content:
        "Nina Novak\nnina@example.test\nBuilt a reliable TypeScript platform.",
    });
    workspace.sources[0].analysisRequired = true;
    workspace.sources[0].status = "processing";

    const analyzer = new CodexCandidateAnalyzer(codex, root);
    const result = await analyzer.analyze(workspace);
    const resumed = await analyzer.analyze(workspace);

    expect(roles).toEqual([
      "candidate-source-reader",
      "candidate-source-coverage-verifier",
      "candidate-intelligence",
      "candidate-source-reader",
      "candidate-source-coverage-verifier",
      "candidate-intelligence",
    ]);
    expect(models).toEqual([
      "gpt-5.6-luna",
      "gpt-5.6-luna",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.6-luna",
      "gpt-5.6-terra",
    ]);
    expect(result.profile.headline).toBe("Platform engineer");
    expect(resumed.profile.headline).toBe("Platform engineer");
    expect(result.profile.skills).toEqual(["TypeScript"]);
    expect(result.sourceInsights[0]).toMatchObject({
      sourceId: workspace.sources[0].id,
      knowledgeMarkdown:
        "## TypeScript platform\n\nBuilt a reliable TypeScript platform.",
    });
  });

  it("does not treat an education year range as a phone number", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-phone-"));
    const service = new JobSearchService(root);
    await service.initialize();
    const workspace = await service.addSource({
      kind: "cv",
      name: "cv.txt",
      content:
        "Candidate Name\ncandidate@example.test\nEducation 2006 - 2011\nSenior platform engineer",
    });
    expect(workspace.profile.phone).toBe("");
    expect(
      workspace.questions.some((question) => question.id === "phone"),
    ).toBe(false);
  });

  it("stores only the original CV name beside the extracted text", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-original-"));
    const service = new JobSearchService(root);
    await service.initialize();
    const original = Buffer.from(
      "Candidate Name\ncandidate@example.test\nSenior platform engineer",
    );
    const workspace = await service.addSource({
      kind: "cv",
      name: "candidate-cv.txt",
      mimeType: "text/plain",
      dataBase64: original.toString("base64"),
    });
    expect(workspace.sources[0].originalFile).toEqual({
      name: "candidate-cv.txt",
    });
    expect(workspace.sources[0]).not.toHaveProperty("mimeType");
    expect(workspace.sources[0]).not.toHaveProperty("size");
    expect(workspace.sources[0]).not.toHaveProperty("contentHash");
    expect(workspace.sources[0]).not.toHaveProperty("sourceVersionId");
    const stored = await service.sourceFile(
      workspace.candidateId,
      workspace.sources[0].id,
    );
    expect(await readFile(stored.file)).toEqual(original);
  });

  it("replaces the active CV and removes its previous original file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-cv-replace-"));
    const service = new JobSearchService(root);
    await service.initialize();

    const first = await service.addSource({
      kind: "cv",
      name: "old-cv.txt",
      dataBase64: Buffer.from("Old candidate evidence for platform work.").toString("base64"),
    });
    const oldSource = first.sources[0];
    const oldFile = await service.sourceFile(first.candidateId, oldSource.id);

    const second = await service.addSource({
      kind: "cv",
      name: "new-cv.txt",
      dataBase64: Buffer.from("New candidate evidence for operations work.").toString("base64"),
    });

    expect(second.sources.filter((source) => source.kind === "cv")).toEqual([
      expect.objectContaining({
        name: "new-cv.txt",
        content: "New candidate evidence for operations work.",
        insights: [],
      }),
    ]);
    expect(second.sources[0].id).not.toBe(oldSource.id);
    await expect(readFile(oldFile.file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an unreadable replacement before changing the active CV", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-cv-invalid-"));
    const service = new JobSearchService(root);
    await service.initialize();

    const first = await service.addSource({
      kind: "cv",
      name: "working-cv.txt",
      dataBase64: Buffer.from(
        "Working candidate evidence for platform engineering.",
      ).toString("base64"),
    });
    const oldCv = first.sources.find((source) => source.kind === "cv")!;
    const oldFile = await service.sourceFile(first.candidateId, oldCv.id);

    await expect(
      service.addSource({
        kind: "cv",
        name: "empty-replacement.pdf",
        dataBase64: "",
      }),
    ).rejects.toMatchObject({
      name: "CvValidationError",
      code: "CV_NOT_OPENABLE",
    });

    const after = await service.get();
    expect(after.sources.filter((source) => source.kind === "cv")).toEqual([
      expect.objectContaining({
        id: oldCv.id,
        name: "working-cv.txt",
        content: "Working candidate evidence for platform engineering.",
      }),
    ]);
    await expect(readFile(oldFile.file, "utf8")).resolves.toContain(
      "Working candidate evidence",
    );
  });

  it("fills the common profile and explains source evidence without adding CV-review questions", async () => {
    const analyzer: CandidateAnalyzer = {
      analyze: async (workspace) => ({
        threadId: "thread-cv-1",
        profile: {
          ...workspace.profile,
          phone: "+421 900 111 222",
          headline: "Senior TypeScript Platform Engineer",
          summary: "Builds reliable developer platforms.",
          skills: ["TypeScript", "Node.js"],
        },
        profileEvidence: [
          {
            field: "phone",
            value: "+421 900 111 222",
            sourceId: workspace.sources[0].id,
            locator: "lines 3-3",
            quote: "+421 900 111 222",
          },
          ...(["headline", "summary", "skills"] as const).flatMap((field) => {
            const values =
              field === "skills"
                ? ["TypeScript", "Node.js"]
                : field === "headline"
                  ? ["Senior TypeScript Platform Engineer"]
                  : ["Builds reliable developer platforms."];
            return values.map((value) => ({
              field,
              value,
              sourceId: workspace.sources[0].id,
              locator: "lines 4-4",
              quote: "Built a TypeScript and Node.js platform",
            }));
          }),
        ],
        sourceInsights: workspace.sources.map((source) => ({
          sourceId: source.id,
          knowledgeMarkdown:
            "## Architecture and hard problems\n\nDesigned durable orchestration and recovery semantics for a production TypeScript platform.",
          insights: [
            {
              id: "insight-1",
              title: "Application orchestration platform",
              summary: "Built a production TypeScript platform.",
              evidence: "Built a TypeScript platform",
              skills: ["TypeScript", "Node.js"],
              category: "project",
            },
          ],
        })),
      }),
    };
    const root = await mkdtemp(
      path.join(tmpdir(), "rolegain-intelligence-"),
    );
    const service = new JobSearchService(root, analyzer);
    await service.initialize();
    const pending = await service.addSource({
      kind: "cv",
      name: "nina-cv.txt",
      content:
        "Nina Novak\nnina@example.test\n+421 900 111 222\nBuilt a TypeScript and Node.js platform",
    });
    expect(pending.intelligence.status).toBe("analyzing");
    expect(pending.sources[0].status).toBe("processing");
    const workspace = await service.analyzeCandidate();
    expect(workspace.profile.phone).toBe("+421 900 111 222");
    expect(workspace.profile.headline).toBe(
      "Senior TypeScript Platform Engineer",
    );
    expect(workspace.sources[0].insights[0].title).toBe(
      "Application orchestration platform",
    );
    const detailRef = workspace.sources[0].knowledgePath;
    expect(detailRef).toMatch(
      /^job-search\/runs\/[^/]+\/evidence-runs\/evidence-[^/]+\/knowledge\/sources\/nina-cv-dot-txt-[^.]+\.md$/,
    );
    expect(workspace.sources[0].insights[0].detailRef).toBe(detailRef);
    expect(
      await readFile(path.join(root, detailRef!), "utf8"),
    ).toContain("durable orchestration and recovery semantics");
    expect(workspace.questions).toHaveLength(5);
    expect("targets" in workspace).toBe(false);
    expect(workspace.finalCv).toContain("Built a TypeScript and Node.js platform");
  });

  it("reruns every source on explicit analysis while keeping ordinary profile edits internal", async () => {
    const analyzedSourceSets: string[][] = [];
    const analyzer: CandidateAnalyzer = {
      analyze: async (workspace) => {
        analyzedSourceSets.push(
          workspace.sources
            .filter(
              (source) =>
                source.analysisRequired ||
                source.status === "processing" ||
                source.insights.length === 0 ||
                !source.knowledgePath,
            )
            .map((source) => source.id),
        );
        return {
          threadId: `thread-${analyzedSourceSets.length}`,
          profile: {
            ...workspace.profile,
            headline: "Evidence-backed engineer",
            skills: ["TypeScript"],
          },
          sourceInsights: workspace.sources.map((source) => ({
            sourceId: source.id,
            knowledgeMarkdown: `Detailed notes for ${source.name}`,
            insights: [
              {
                id: `insight-${source.id}`,
                title: source.name,
                summary: "Supported candidate evidence.",
                evidence: source.content || source.url || source.name,
                skills: ["TypeScript"],
                category: "experience",
              },
            ],
          })),
        };
      },
    };
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-evidence-change-"));
    const service = new JobSearchService(root, analyzer);
    await service.initialize();
    await service.addSource({
      kind: "cv",
      name: "candidate-cv.txt",
      content: "Candidate built a TypeScript platform.",
    });
    const analyzed = await service.analyzeCandidate();
    expect(analyzedSourceSets).toHaveLength(1);
    expect(analyzed.sources[0].insights).toHaveLength(1);

    const reanalyzed = await service.analyzeCandidate();
    expect(analyzedSourceSets).toHaveLength(2);
    expect(analyzedSourceSets.at(-1)).toEqual([
      reanalyzed.sources[0].id,
    ]);
    expect(reanalyzed.sources[0].analysisRequired).toBe(false);

    const internalEdit = await service.updateProfile({ phone: "+421 900 123 456" });
    expect(internalEdit.intelligence.status).toBe("ready");
    expect(internalEdit.discoveryNeedsRun).toBe(true);
    expect(internalEdit.sources[0].insights).toHaveLength(1);
    expect(analyzedSourceSets).toHaveLength(2);

    const invalidated = await service.addSource({
      kind: "document",
      name: "project-notes.md",
      content: "Designed reliable distributed processing.",
    });
    expect(invalidated.intelligence.status).toBe("analyzing");
    expect(invalidated.sources[0].insights).toHaveLength(1);
    expect(invalidated.sources[0].knowledgePath).toBeTruthy();
    expect(invalidated.sources.every((source) => source.analysisRequired)).toBe(true);

    const rebuilt = await service.analyzeCandidate();
    expect(analyzedSourceSets.at(-1)).toHaveLength(2);
    expect(rebuilt.sources.every((source) => source.insights.length === 1)).toBe(true);
  });

  it("keeps LinkedIn as a saved link without attempting automated reading", async () => {
    const analyzer: CandidateAnalyzer = {
      analyze: async (workspace) => ({
        threadId: "thread-linkedin-fallback",
        profile: {
          ...workspace.profile,
          headline: "Protocol engineer",
          skills: ["Solidity"],
        },
        sourceInsights: workspace.sources
          .filter(
            (source) =>
              source.status !== "needs_review" && Boolean(source.content),
          )
          .map((source) => ({
            sourceId: source.id,
            knowledgeMarkdown: `Detailed notes for ${source.name}`,
            insights: [
              {
                id: `insight-${source.id}`,
                title: "Existing verified evidence",
                summary: "Built a supported protocol system.",
                evidence: source.content!,
                skills: ["Solidity"],
                category: "project",
              },
            ],
          })),
      }),
    };
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-linkedin-999-"));
    const service = new JobSearchService(
      root,
      analyzer,
      undefined,
      undefined,
      async () => {
        throw new Error("Could not read www.linkedin.com (999)");
      },
    );
    await service.initialize();
    await service.addSource({
      kind: "cv",
      name: "candidate-cv.txt",
      content: "Built a supported Solidity protocol.",
    });
    const before = await service.analyzeCandidate();
    expect(before.sources[0].insights).toHaveLength(1);

    await service.updateProfile({
      linkedin: "https://www.linkedin.com/in/candidate/",
    });
    const after = await service.analyzeCandidate();
    const cv = after.sources.find((source) => source.kind === "cv")!;
    expect(cv.insights).toHaveLength(1);
    expect(cv.knowledgePath).toBeTruthy();
    expect(
      after.sources.some((source) => source.profileField === "linkedin"),
    ).toBe(false);
    expect(after.profile.linkedin).toBe(
      "https://www.linkedin.com/in/candidate/",
    );
    expect(after.intelligence.status).toBe("ready");
  });
});
