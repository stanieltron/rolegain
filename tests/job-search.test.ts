import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  JobSearchService,
  coalesceSearchVerificationSeeds,
  discoveryLimitAfterBenchValidation,
  evidenceUrlsMatch,
  selectPhase2ApplicationPortfolio,
  stageProfileEvidenceSources,
} from "../src/backend/control-flow/service.js";
import type {
  ApplicationDraft,
  JobOpportunity,
  JobResearchFailure,
  JobSearchWorkspace,
} from "../src/contracts/job-search.js";
import type { CoverLetterWriter } from "../src/04-application-preparation/types.js";
import { compatibleCandidateValue } from "../src/search-match-shared/candidate-facts.js";
import {
  calculateOpportunityConfidence,
  extractQualificationSection,
  extractResponsibilitiesSection,
  matchesWorkplace,
  meetsCompensationFloor,
  normalizeCompensationText,
  parseCompensationRanges,
  reconcileRemoteLocation,
} from "../src/search-match-shared/opportunity.js";
import { validatedDiscoveryTarget } from "../src/02-search/v1/01-discovery/index.js";
import { discoveryWorkIntent } from "../src/search-match-shared/search-intent.js";
import { greenhouseJobApiUrl } from "../src/02-search/v1/03-vacancy-validation/index.js";
import {
  calculateRequirementFit,
  requirementIsExplicitQualification,
} from "../src/03-match/shared/01-requirement-matching/index.js";
import {
  normalizeExtractedText,
  repairMojibake,
} from "../src/infrastructure/text-encoding.js";

const deterministicResearch = {
  async research(workspace: JobSearchWorkspace) {
    const titles = [
      "Codex Core Agents",
      "Platform Engineer",
      "Infrastructure Engineer",
      "Security Engineer",
      "Backend Engineer",
    ];
    const opportunities: JobOpportunity[] = titles.map((title, index) => ({
      id: index === 0 ? "codex-core" : `test-job-${index}`,
      company: index === 0 ? "OpenAI" : `Employer ${index}`,
      title,
      location: "Remote",
      workplace: "Remote",
      compensation: "EUR 120000 per year",
      sourceUrl: `https://jobs.example.test/${index}`,
      applyUrl: `https://jobs.example.test/${index}/application`,
      capturedAt: "2026-07-13",
      fit: 80 - index,
      summary: `${title} role`,
      requirements: [],
      requirementMatches: [],
      strengths: [],
      gaps: [],
    }));
    const applications: ApplicationDraft[] = opportunities.map((job) => {
      const fields: ApplicationDraft["formFields"] = [
        ["name", "Full name", workspace.profile.name, "profile"],
        ["email", "Email", workspace.profile.email, "profile"],
        ["phone", "Phone", workspace.profile.phone, "profile"],
        ["linkedin", "LinkedIn URL", "", "user"],
        ["authorization", "Work authorization / sponsorship", "", "profile"],
        ["salary", "Compensation expectation", workspace.profile.salaryExpectation, "profile"],
        ["cover", "Cover letter", "", "generated"],
      ].map(([id, label, value, source]) => ({
        id,
        canonicalKey: id,
        externalName: id,
        label,
        type:
          id === "phone"
            ? "tel"
            : id === "email"
              ? "email"
              : id === "cover"
                ? "textarea"
                : "text",
        value,
        required: true,
        source: source as "profile" | "user",
        confidence: value ? 100 : 0,
      }));
      const missingQuestions = fields.filter((field) => !field.value).map((field) => field.label);
      return {
        id: `app-${job.id}`,
        jobId: job.id,
        status: "needs_input",
        coverLetter: `Dear ${job.company}, I am applying for ${job.title}.`,
        coverLetterChat: [],
        formFields: fields,
        missingQuestions,
        adapter: "generic",
        liveFormValidated: true,
        formSchema: {
          observedQuestionCount: fields.length,
          mappedQuestionCount: fields.length,
          fingerprint: "schema-test",
          issues: [],
          verifiedByAgent: true,
        },
        updatedAt: new Date().toISOString(),
      };
    });
    return { opportunities, applications };
  },
};

const deterministicCoverLetterWriter: CoverLetterWriter = {
  async draft(workspace, applicationIds) {
    return applicationIds.map((applicationId) => {
      const application = workspace.applications.find(
        (item) => item.id === applicationId,
      )!;
      const job = workspace.opportunities.find(
        (item) => item.id === application.jobId,
      )!;
      return {
        applicationId,
        coverLetter: `Grounded draft for ${job.title}.`,
      };
    });
  },
  async refine(_workspace, application, message) {
    return {
      coverLetter: `${application.coverLetter}\n\nRevision: ${message}`,
      assistantMessage: "Updated the letter using the requested emphasis.",
      threadId: application.coverLetterThreadId || "cover-thread-1",
    };
  },
  async refineAnswer(_workspace, _application, field, message) {
    return {
      value: `${field.value}\n\nRevision: ${message}`,
      evidenceBasis: field.evidence || "candidate evidence",
    };
  },
  async tailorCv(workspace, application) {
    const job = workspace.opportunities.find(
      (candidate) => candidate.id === application.jobId,
    )!;
    return {
      content: `# ${workspace.profile.name}

## Summary
Platform engineer applying for ${job.title} using only verified experience.

## Experience
- Built and operated reliable TypeScript services for production teams.
- Improved deployment safety through validation, observability, and rollback controls.
- Worked with PostgreSQL, Docker, and developer tooling across delivery workflows.

## Skills
- TypeScript
- PostgreSQL
- Docker`,
      changeSummary: [
        `Emphasized verified experience relevant to ${job.title}`,
        "Moved deployment reliability evidence earlier",
      ],
    };
  },
};

const incrementalResearch = {
  async research(
    workspace: JobSearchWorkspace,
    options?: { excludeApplyUrls?: string[] },
  ) {
    const result = await deterministicResearch.research(workspace);
    if (!options?.excludeApplyUrls?.length) return result;
    const opportunities = result.opportunities.map((job, index) => ({
      ...job,
      id: `more-job-${index}`,
      company: `Additional Employer ${index}`,
      sourceUrl: `https://more.example.test/${index}`,
      applyUrl: `https://more.example.test/${index}/application`,
    }));
    const applications = result.applications.map((application, index) => ({
      ...application,
      id: `app-more-job-${index}`,
      jobId: opportunities[index].id,
    }));
    return { opportunities, applications };
  },
};

const serviceFor = (root: string) =>
  new JobSearchService(
    root,
    undefined,
    deterministicResearch,
    deterministicCoverLetterWriter,
  );

describe("job-search lifecycle", () => {
  it("stops deep discovery once there is a ranked replacement bench", () => {
    expect(validatedDiscoveryTarget(20, 5)).toBe(13);
    expect(validatedDiscoveryTarget(8, 5)).toBe(8);
    expect(validatedDiscoveryTarget(20, 1)).toBe(4);
  });

  it("discovers only after validating an insufficient scored bench", () => {
    expect(
      discoveryLimitAfterBenchValidation({
        remainingApplications: 5,
        reusableOpenJobs: 5,
        configuredDiscoveryTarget: 20,
        firstBatch: false,
        refillRound: 0,
      }),
    ).toBe(0);
    expect(
      discoveryLimitAfterBenchValidation({
        remainingApplications: 5,
        reusableOpenJobs: 4,
        configuredDiscoveryTarget: 20,
        firstBatch: false,
        refillRound: 0,
      }),
    ).toBe(6);
    expect(
      discoveryLimitAfterBenchValidation({
        remainingApplications: 5,
        reusableOpenJobs: 0,
        configuredDiscoveryTarget: 20,
        firstBatch: true,
        refillRound: 0,
      }),
    ).toBe(20);
  });

  it("isolates parallel matching and application-verification failures per job", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-isolated-pipeline-"));
    const jobs: JobOpportunity[] = [
      ["good-job", "Good Protocol Engineer", 92],
      ["match-fails", "Matcher Timeout Role", 88],
      ["verification-fails", "Verifier Timeout Role", 84],
      ["inspection-fails", "Form Inspection Timeout Role", 80],
    ].map(([id, title, fit]) => ({
      id: String(id),
      company: `${id} Labs`,
      title: String(title),
      location: "Remote",
      workplace: "Remote",
      compensation: "Not disclosed",
      sourceUrl: `https://jobs.example.test/${id}`,
      applyUrl: `https://jobs.example.test/${id}/apply`,
      capturedAt: "2026-07-18",
      fit: Number(fit),
      summary: String(title),
      description: String(title),
      requirements: [],
      requirementMatches: [],
      strengths: [],
      gaps: [],
    }));
    let activeAssessments = 0;
    let maxActiveAssessments = 0;
    let activeInspections = 0;
    let maxActiveInspections = 0;
    const research = {
      async research() {
        return { opportunities: jobs, applications: [], failures: [] };
      },
      async assess(
        _workspace: JobSearchWorkspace,
        [job]: JobOpportunity[],
      ) {
        activeAssessments += 1;
        maxActiveAssessments = Math.max(maxActiveAssessments, activeAssessments);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeAssessments -= 1;
        if (job.id === "match-fails") throw new Error("matching worker timed out");
        return [{ ...job }];
      },
      async inspectApplications(
        workspace: JobSearchWorkspace,
        selected: JobOpportunity[],
      ) {
        activeInspections += 1;
        maxActiveInspections = Math.max(maxActiveInspections, activeInspections);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeInspections -= 1;
        if (selected[0].id === "inspection-fails")
          throw new Error("form inspection timed out");
        return {
          applications: selected.map((job): ApplicationDraft => ({
            id: `app-${job.id}`,
            jobId: job.id,
            status: "ready_to_send",
            coverLetter: "",
            coverLetterChat: [],
            formFields: [
              {
                id: "name",
                canonicalKey: "name",
                externalName: "name",
                label: "Full name",
                type: "text",
                value: workspace.profile.name,
                required: true,
                source: "profile",
                confidence: 100,
              },
              {
                id: "cover",
                canonicalKey: "cover_letter",
                externalName: "coverLetter",
                label: "Cover letter",
                type: "textarea",
                value: "",
                required: false,
                source: "generated",
                confidence: 0,
              },
            ],
            missingQuestions: [],
            adapter: "generic",
            liveFormValidated: true,
            formSchema: {
              observedQuestionCount: 2,
              mappedQuestionCount: 2,
              fingerprint: `schema-${job.id}`,
              issues: [],
              verifiedByAgent: true,
            },
            updatedAt: new Date().toISOString(),
          })),
          failures: [],
        };
      },
    };
    const writer: CoverLetterWriter = {
      ...deterministicCoverLetterWriter,
      async draft(_workspace, [applicationId]) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (applicationId === "app-verification-fails")
          throw new Error("application verifier timed out");
        return [{ applicationId, coverLetter: "Verified grounded letter" }];
      },
    };
    const service = new JobSearchService(root, undefined, research, writer);
    await service.initialize();
    await service.addSource({
      kind: "cv",
      name: "candidate.txt",
      content: "Candidate Name\ncandidate@example.test\nProtocol engineer",
    });
    await service.updateProfile({
      name: "Candidate Name",
      email: "candidate@example.test",
    });
    for (const id of ["locations", "employment", "start", "languages"])
      await service.answer(id, "Confirmed");
    await service.finishIntake();

    const result = await service.prepareApplications();

    expect(maxActiveAssessments).toBe(4);
    expect(maxActiveInspections).toBe(3);
    expect(result.searchProgress).toMatchObject({
      stage: "ready",
      target: 5,
      found: 1,
      error: expect.stringContaining("Prepared 1 of 5"),
    });
    expect(
      result.searchProgress?.items?.some(
        (item) =>
          item.validation === "running" ||
          item.match === "running" ||
          item.application === "running" ||
          item.applicationVerification === "running",
      ),
    ).toBe(false);
    expect(
      result.searchProgress?.items?.find((item) => item.id === "match-fails"),
    ).toMatchObject({ match: "failed", application: "waiting" });
    expect(
      result.searchProgress?.items?.find(
        (item) => item.id === "verification-fails",
      ),
    ).toMatchObject({
      match: "passed",
      application: "failed",
      applicationVerification: "failed",
    });
    expect(
      result.searchProgress?.items?.find(
        (item) => item.id === "inspection-fails",
      ),
    ).toMatchObject({
      match: "passed",
      application: "failed",
      applicationVerification: "waiting",
    });
    expect(
      result.searchProgress?.items?.find((item) => item.id === "good-job"),
    ).toMatchObject({
      match: "passed",
      application: "passed",
      applicationVerification: "passed",
    });
    expect(result.searchValidationIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Matcher Timeout Role",
          stage: "requirements",
          disposition: "unresolved",
          reasonCode: "matching_verification",
        }),
        expect.objectContaining({
          title: "Form Inspection Timeout Role",
          stage: "form",
          reasonCode: "application_form",
        }),
      ]),
    );
    expect(
      result.applications.filter((application) =>
        result.searchProgress?.items?.some(
          (item) =>
            item.id === application.jobId &&
            item.applicationVerification === "passed",
        ),
      ),
    ).toHaveLength(1);
  });

  it("promotes only crawlable profile links into managed evidence sources", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-profile-links-"));
    const service = new JobSearchService(root);
    await service.initialize();
    const workspace = await service.get();
    workspace.profile.linkedin = "https://www.linkedin.com/in/candidate";
    workspace.profile.github = "https://github.com/candidate";
    workspace.profile.website = "https://candidate.example";

    expect(
      stageProfileEvidenceSources(workspace, [
        "linkedin",
        "github",
        "website",
      ]),
    ).toEqual({ changed: true, needsFetch: true });
    expect(workspace.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profileField: "github",
          kind: "github",
          status: "processing",
        }),
        expect.objectContaining({
          profileField: "website",
          kind: "portfolio",
          status: "processing",
        }),
      ]),
    );
    expect(
      workspace.sources.some((source) => source.profileField === "linkedin"),
    ).toBe(false);
    expect(
      stageProfileEvidenceSources(workspace, [
        "linkedin",
        "github",
        "website",
      ]),
    ).toEqual({ changed: false, needsFetch: false });

    workspace.profile.github = "";
    expect(stageProfileEvidenceSources(workspace, ["github"])).toEqual({
      changed: true,
      needsFetch: false,
    });
    expect(
      workspace.sources.some((source) => source.profileField === "github"),
    ).toBe(false);

    const website = workspace.sources.find(
      (source) => source.profileField === "website",
    )!;
    website.status = "needs_review";
    website.analysisRequired = false;
    website.error = "Reading was stopped by the user.";
    expect(stageProfileEvidenceSources(workspace, ["website"])).toEqual({
      changed: false,
      needsFetch: false,
    });
  });

  it("reuses an equivalent www website source instead of staging a duplicate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-profile-www-"));
    const service = new JobSearchService(root);
    await service.initialize();
    const workspace = await service.get();
    workspace.profile.website = "stanislavvozarik.com";
    workspace.sources.push({
      id: "manual-website",
      kind: "webpage",
      name: "www.stanislavvozarik.com",
      url: "https://www.stanislavvozarik.com/",
      content: "Already ingested portfolio evidence.",
      status: "ready",
      analysisRequired: false,
      insights: [],
      addedAt: new Date().toISOString(),
    });
    workspace.sources.push({
      id: "stale-managed-website",
      kind: "portfolio",
      name: "Personal website",
      url: "https://stanislavvozarik.com/",
      profileField: "website",
      content: "",
      status: "processing",
      insights: [],
      addedAt: new Date().toISOString(),
    });

    expect(stageProfileEvidenceSources(workspace, ["website"])).toEqual({
      changed: true,
      needsFetch: false,
    });
    expect(
      workspace.sources.filter((source) =>
        /stanislavvozarik\.com/.test(source.url || ""),
      ),
    ).toEqual([expect.objectContaining({ id: "manual-website", status: "ready" })]);
  });

  it("keeps a manually entered website unexplored until explicitly requested", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-profile-fetch-"));
    let ingestCalls = 0;
    const service = new JobSearchService(
      root,
      undefined,
      undefined,
      undefined,
      async (input) => {
        ingestCalls += 1;
        return {
          kind: input.kind,
          name: input.name,
          url: input.url,
          content:
            "Portfolio evidence: designed and shipped a verified workflow system.",
          contentHash: "portfolio-evidence-hash",
        };
      },
    );
    await service.initialize();
    const saved = await service.updateProfile(
      { website: "https://candidate.example" },
      { deferEvidenceAnalysis: true },
    );
    expect(ingestCalls).toBe(0);
    expect(saved.sources).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profileField: "website",
        }),
      ]),
    );

    const staged = await service.exploreProfileEvidence(
      "website",
      saved.candidateId,
      false,
    );
    expect(staged.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profileField: "website",
          status: "processing",
        }),
      ]),
    );
    const analyzed = await service.analyzeCandidate();
    expect(ingestCalls).toBe(1);
    expect(analyzed.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profileField: "website",
          status: "ready",
          content: expect.stringContaining("verified workflow system"),
        }),
      ]),
    );
  });

  it("treats redirects across scheme, www, and trailing slash as one evidence URL", () => {
    expect(
      evidenceUrlsMatch(
        "http://www.candidate.example/",
        "https://candidate.example",
      ),
    ).toBe(true);
    expect(
      evidenceUrlsMatch(
        "https://candidate.example/work?view=full",
        "https://www.candidate.example/work/?view=full",
      ),
    ).toBe(true);
    expect(
      evidenceUrlsMatch(
        "https://candidate.example/work",
        "https://candidate.example/other",
      ),
    ).toBe(false);
  });

  it("refreshes metadata and review state when identical evidence is added again", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-source-refresh-"));
    const service = new JobSearchService(root);
    await service.initialize();
    const first = await service.addSource({
      kind: "document",
      name: "evidence.txt",
      content: "Implemented a bounded recovery workflow.",
    });
    await service.markSourceReadingStopped(first.sources[0].id);
    const refreshed = await service.addSource({
      kind: "document",
      name: "evidence.txt",
      content: "Implemented a bounded recovery workflow.",
    });

    expect(refreshed.sources).toHaveLength(1);
    expect(refreshed.sources[0]).toMatchObject({
      id: first.sources[0].id,
      status: "ready",
      error: undefined,
    });
  });

  it("prevents supplemental duplicates with one simple content hash", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-source-dedupe-"));
    const service = new JobSearchService(root);
    await service.initialize();
    await service.addSource({
      kind: "cv",
      name: "cv.txt",
      content: "Candidate Name\ncandidate@example.test\nPlatform engineer",
    });
    const first = await service.addSource({
      kind: "document",
      name: "project-one.txt",
      content: "Built a reliable platform.\n\nLed production operations.",
    });
    const duplicate = await service.addSource({
      kind: "document",
      name: "renamed-copy.txt",
      content: "Built   a reliable platform.\n\n\nLed production operations.",
    });

    const supplemental = duplicate.sources.filter(
      (source) => source.kind !== "cv",
    );
    expect(supplemental).toHaveLength(1);
    expect(supplemental[0].id).toBe(
      first.sources.find((source) => source.kind !== "cv")?.id,
    );
    expect(supplemental[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(supplemental[0]).not.toHaveProperty("sourceVersionId");
    expect(supplemental[0]).not.toHaveProperty("mimeType");
    expect(duplicate.sources.find((source) => source.kind === "cv")).not.toHaveProperty(
      "contentHash",
    );
  });

  it("repairs Windows-1252 mojibake without changing clean Unicode", () => {
    expect(
      repairMojibake(
        "â‚¬108K â€“ â‚¬133K â€¢ Offers Equity. Hi ðŸ‘‹ðŸ¾ Iâ€™m Abhik",
      ),
    ).toBe("€108K – €133K • Offers Equity. Hi 👋🏾 I’m Abhik");
    expect(repairMojibake("Clean €120K – €140K 👋")).toBe(
      "Clean €120K – €140K 👋",
    );
    expect(repairMojibake("André works in München")).toBe(
      "André works in München",
    );
  });

  it("repairs Central European mojibake produced by a Windows-1252 round trip", () => {
    expect(repairMojibake("L\u00c4\u2122dziny")).toBe("L\u0119dziny");
    expect(repairMojibake("p\u00c3\u00a2tissier")).toBe("p\u00e2tissier");
    expect(repairMojibake("Clean \u20ac120K \u2013 \u20ac140K")).toBe(
      "Clean \u20ac120K \u2013 \u20ac140K",
    );
  });

  it("decodes HTML entities leaked by vacancy metadata", () => {
    expect(repairMojibake("Maisons Bocuse &amp; C-Gastronomie")).toBe(
      "Maisons Bocuse & C-Gastronomie",
    );
    expect(repairMojibake("R&amp;D &#8211; Lyon &#x1f1eb;&#x1f1f7;")).toBe(
      "R&D – Lyon 🇫🇷",
    );
  });

  it("turns job-board HTML descriptions into readable plain text", () => {
    expect(
      normalizeExtractedText(
        "&lt;p&gt;&lt;strong&gt;Vos missions&lt;/strong&gt;&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Préparer les desserts&lt;/li&gt;&lt;/ul&gt;",
      ),
    ).toBe("Vos missions\n- Préparer les desserts");
  });

  it("does not present benefit reimbursements as salary", () => {
    expect(
      normalizeCompensationText(
        "Mutuelle santé : pack bien-être jusqu’à 350€ remboursés par an",
      ),
    ).toBe("");
    expect(normalizeCompensationText("Salaire brut : 2100 EUR par mois")).toBe(
      "Salaire brut : 2100 EUR par mois",
    );
    expect(normalizeCompensationText("€45,000–€55,000 per year")).toBe(
      "€45,000–€55,000 per year",
    );
  });

  it("preserves completed records when an active search is interrupted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-recovery-"));
    const first = serviceFor(root);
    await first.initialize();
    const workspace = await first.get();
    const partial = await deterministicResearch.research(workspace);
    workspace.opportunities = partial.opportunities.slice(0, 1);
    workspace.applications = partial.applications.slice(0, 1);
    workspace.searchProgress = { stage: "filling", target: 5, found: 1 };
    await writeFile(
      path.join(root, "job-search", "candidates", `${workspace.candidateId}.json`),
      JSON.stringify(workspace, null, 2),
      "utf8",
    );

    const restarted = serviceFor(root);
    await restarted.initialize();
    const recovered = await restarted.get();
    expect(recovered.opportunities).toHaveLength(1);
    expect(recovered.applications).toHaveLength(1);
    expect(recovered.searchProgress).toMatchObject({
      stage: "failed",
      target: 5,
      found: 1,
    });
    expect(recovered.searchProgress?.error).toContain("server restart");
  });

  it("derives match percentage from weighted requirement evidence", () => {
    expect(
      calculateRequirementFit([
        {
          id: "required-matched",
          kind: "required",
          requirement: "Distributed systems",
          status: "matched",
          explanation: "Direct evidence",
          evidence: [],
        },
        {
          id: "required-missing",
          kind: "required",
          requirement: "C++",
          status: "missing",
          explanation: "No evidence",
          evidence: [],
        },
        {
          id: "preferred-partial",
          kind: "preferred",
          requirement: "Kubernetes",
          status: "partial",
          explanation: "Adjacent evidence",
          evidence: [],
        },
        {
          id: "preferred-matched",
          kind: "preferred",
          requirement: "Observability",
          status: "matched",
          explanation: "Direct evidence",
          evidence: [],
        },
      ]),
    ).toBe(58);
  });

  it("keeps an application refinement conversation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-cover-chat-"));
    const service = new JobSearchService(
      root,
      undefined,
      deterministicResearch,
      deterministicCoverLetterWriter,
    );
    await service.initialize();
    await service.updateProfile({
      name: "Taylor Reed",
      email: "taylor@example.test",
    });
    await service.addSource({
      kind: "cv",
      name: "taylor-cv.txt",
      content: "Taylor Reed, platform engineer",
    });
    for (const id of ["locations", "employment", "start", "languages"])
      await service.answer(id, "Confirmed answer");
    await service.finishIntake();
    const staged = await service.prepareApplications();
    expect(staged.applications.every((application) => application.coverLetter)).toBe(true);
    const refined = await service.refineCoverLetter(
      staged.applications[0].id,
      "Make the opening more concise.",
    );
    expect(refined.applications[0].coverLetter).toContain(
      "Revision: Make the opening more concise.",
    );
    expect(refined.applications[0].coverLetterThreadId).toBe("cover-thread-1");
    expect(refined.applications[0].coverLetterChat).toMatchObject([
      { role: "user", content: "Make the opening more concise." },
      {
        role: "assistant",
        content: "Updated the letter using the requested emphasis.",
      },
    ]);
  });

  it("generates and serves an on-demand tailored CV only for a prepared application", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-tailored-cv-"));
    const service = serviceFor(root);
    await service.initialize();
    await service.updateProfile({
      name: "Taylor Reed",
      email: "taylor@example.test",
    });
    await service.addSource({
      kind: "cv",
      name: "taylor-cv.txt",
      content:
        "Taylor Reed\nPlatform engineer\nBuilt reliable TypeScript services and safer deployments.",
    });
    for (const id of ["locations", "employment", "start", "languages"])
      await service.answer(id, "Confirmed answer");
    await service.finishIntake();
    const staged = await service.prepareApplications();
    const applicationId = staged.applications[0].id;

    const tailored = await service.tailorApplicationCv(applicationId);
    expect(tailored.applications[0].tailoredCv).toMatchObject({
      status: "ready",
      fileName: expect.stringMatching(/\.docx$/),
      changeSummary: expect.arrayContaining([
        expect.stringContaining("Emphasized verified experience"),
      ]),
    });

    const document = await service.tailoredCvFile(
      tailored.candidateId,
      applicationId,
    );
    expect(document.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(document.size).toBeGreaterThan(500);
  });

  it("fills grounded narrative answers but rejects generated sensitive facts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-grounded-"));
    const research = {
      async research(workspace: JobSearchWorkspace) {
        const result = await deterministicResearch.research(workspace);
        result.applications[0].formFields.push({
          id: "shipping-choice",
          canonicalKey: "shipping_choice",
          externalName: "shippingChoice",
          label: "Describe a choice you made while shipping a product",
          type: "textarea" as const,
          value: "",
          required: true,
          source: "user" as const,
          confidence: 0,
        });
        result.applications[0].formSchema!.observedQuestionCount =
          result.applications[0].formFields.length;
        result.applications[0].formSchema!.mappedQuestionCount =
          result.applications[0].formFields.length;
        return result;
      },
    };
    const writer: CoverLetterWriter = {
      ...deterministicCoverLetterWriter,
      async draft(workspace, applicationIds) {
        return applicationIds.map((applicationId) => ({
          applicationId,
          coverLetter: "Grounded cover letter",
          answers:
            applicationId === workspace.applications[0].id
              ? [
                  {
                    fieldId: "shipping-choice",
                    value: "I advocated for a safer release path backed by production evidence.",
                    evidenceBasis: "alex-chen-cv.md: platform delivery experience",
                  },
                  {
                    fieldId: "phone",
                    value: "+1 555 555 5555",
                    evidenceBasis: "Not actually supplied",
                  },
                ]
              : [],
        }));
      },
    };
    const service = new JobSearchService(root, undefined, research, writer);
    await service.initialize();
    await service.addSource({
      kind: "cv",
      name: "alex-chen-cv.md",
      content: "Alex Chen, platform engineer with production delivery experience",
    });
    await service.updateProfile({
      name: "Alex Chen",
      email: "alex.chen@example.test",
    });
    for (const id of ["locations", "employment", "start", "languages"])
      await service.answer(id, "Confirmed answer");
    await service.finishIntake();
    const staged = await service.prepareApplications();
    const application = staged.applications[0];
    expect(
      application.formFields.find((field) => field.id === "shipping-choice"),
    ).toMatchObject({
      source: "generated",
      confidence: 85,
      evidence: "alex-chen-cv.md: platform delivery experience",
    });
    expect(
      application.formFields.find((field) => field.id === "phone")?.value,
    ).toBe("");
    expect(application.missingQuestions).not.toContain(
      "Describe a choice you made while shipping a product",
    );
    const refined = await service.refineApplicationField(
      application.id,
      "shipping-choice",
      "Make the answer more concise.",
    );
    expect(
      refined.applications[0].formFields.find(
        (field) => field.id === "shipping-choice",
      ),
    ).toMatchObject({
      source: "generated",
      confidence: 85,
      evidence: "alex-chen-cv.md: platform delivery experience",
    });
    expect(
      refined.applications[0].formFields.find(
        (field) => field.id === "shipping-choice",
      )?.value,
    ).toContain("Revision: Make the answer more concise.");
  });

  it("supports a remote-only candidate without a current location", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-cv-first-"));
    const service = serviceFor(root);
    await service.initialize();
    const blank = await service.get();
    expect(blank.profile.name).toBe("");
    expect(blank.profileSetupStep).toBe(1);
    const withCv = await service.addSource({
      kind: "cv",
      name: "taylor-cv.txt",
      content: "Taylor Reed\ntaylor@example.test\nPlatform engineer",
    });
    expect(withCv.profile.email).toBe("taylor@example.test");
    expect(withCv.profile.location).toBe("");
    expect(withCv.profileSetupStep).toBe(2);
    const completedBasics = await service.updateProfile({
      name: "Taylor Reed",
    });
    expect(completedBasics.profileSetupStep).toBe(3);
    expect((await service.analyzeCandidate()).profileSetupStep).toBe(3);
    await service.answer("locations", "Remote");
    const remoteProfile = await service.get();
    expect(remoteProfile.profile.workplace).toBe("Remote");
    expect(remoteProfile.profile.targetLocations).toBe("");
    expect(discoveryWorkIntent(remoteProfile)).toMatchObject({
      workplaceModes: ["Remote"],
      willingWorkLocations: [],
      remoteEligibility: ["Any region"],
    });
    for (const id of ["employment", "start", "languages"])
      await service.answer(id, "Confirmed answer");
    expect((await service.get()).profileCompleteness).toBe(100);
    await expect(service.finishIntake()).resolves.toMatchObject({
      phase: "search",
      profileSetupStep: 4,
    });
  });

  it("gates search until the sourced profile is complete and stages five applications", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-job-search-"));
    const service = serviceFor(root);
    await service.initialize();
    await expect(service.finishIntake()).rejects.toThrow(
      "Add a CV, confirm name and email",
    );
    await service.updateProfile({
      name: "Alex Chen",
      email: "alex.chen@example.test",
      location: "Seattle",
    });
    await service.addSource({
      kind: "cv",
      name: "alex-chen-cv.md",
      content: "Alex Chen, platform engineer",
    });
    await service.updateProfile({
      name: "Alex Chen",
      email: "alex.chen@example.test",
    });
    const answers: Record<string, string> = {
      locations: "Remote, Hybrid: Seattle, WA | San Francisco, CA",
      employment: "Full-time",
      start: "2026-08-15",
      languages: "English (Fluent)",
    };
    for (const [id, answer] of Object.entries(answers))
      await service.answer(id, answer);
    expect((await service.get()).profile).toMatchObject({
      workplace: "Remote, Hybrid",
      targetLocations: "Seattle, WA | San Francisco, CA",
    });
    expect((await service.get()).profileCompleteness).toBe(100);
    await service.finishIntake();
    let result = await service.prepareApplications();
    expect(result.opportunities).toHaveLength(5);
    expect(result.applications).toHaveLength(5);
    expect(
      result.applications.every((item) => item.addedBy === "agent"),
    ).toBe(true);
    expect(
      result.applications.every((item) => item.status === "needs_input"),
    ).toBe(true);
    expect(result.applications.every((item) => item.liveFormValidated)).toBe(
      true,
    );
    expect(result.searchProgress).toMatchObject({
      stage: "ready",
      target: 5,
      found: 5,
      error: undefined,
    });
    for (const application of result.applications)
      result = await service.updateApplication(application.id, {
        fields: {
          linkedin: "https://linkedin.com/in/alex",
          phone: "+1 206 555 0147",
          authorization: "Authorized in the US; no sponsorship required",
          salary: "Open to the role's budgeted range",
        },
      });
    expect(
      result.applications.every((item) => item.status === "ready_to_send"),
    ).toBe(true);
    expect(
      result.applications.every((item) =>
        item.missingQuestions.includes("Employer form requires manual review"),
      ),
    ).toBe(false);
    expect(
      result.applications.every((item) =>
        item.coverLetter.includes(
          result.opportunities.find((job) => job.id === item.jobId)!.title,
        ),
      ),
    ).toBe(true);
  });

  it("reopens a draft when a required mapped field is cleared", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "rolegain-job-search-edit-"),
    );
    const service = serviceFor(root);
    await service.initialize();
    await service.addSource({
      kind: "cv",
      name: "alex-chen-cv.md",
      content: "Alex Chen, platform engineer",
    });
    await service.updateProfile({
      name: "Alex Chen",
      email: "alex.chen@example.test",
    });
    for (const id of ["locations", "employment", "start", "languages"])
      await service.answer(id, "Test answer");
    await service.finishIntake();
    const staged = await service.prepareApplications();
    const result = await service.updateApplication(staged.applications[0].id, {
      fields: { phone: "" },
    });
    expect(result.applications[0].status).toBe("needs_input");
    expect(result.applications[0].missingQuestions).toContain("Phone");
    const job = result.opportunities.find(
      (item) => item.id === result.applications[0].jobId,
    )!;
    const autofill = await service.autofillByUrl(job.applyUrl);
    expect(autofill?.applicationId).toBe(result.applications[0].id);
    expect((await service.get()).applications[0].status).toBe("needs_input");
    expect((await service.get()).applications[0].addedBy).toBe("agent");
  });

  it("stops an active search and continues the same five-application batch", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-stop-resume-"));
    let releaseFirstSearch!: () => void;
    let markFirstSearchStarted!: () => void;
    const firstSearchStarted = new Promise<void>((resolve) => {
      markFirstSearchStarted = resolve;
    });
    const firstSearchGate = new Promise<void>((resolve) => {
      releaseFirstSearch = resolve;
    });
    let researchCalls = 0;
    const research = {
      ...deterministicResearch,
      async research(workspace: JobSearchWorkspace) {
        researchCalls += 1;
        if (researchCalls === 1) {
          markFirstSearchStarted();
          await firstSearchGate;
        }
        return deterministicResearch.research(workspace);
      },
    };
    const service = new JobSearchService(
      root,
      undefined,
      research,
      deterministicCoverLetterWriter,
    );
    await service.initialize();
    await service.addSource({ kind: "cv", name: "cv.txt", content: "Candidate" });
    await service.updateProfile({
      name: "Candidate",
      email: "candidate@example.test",
    });
    for (const id of ["locations", "employment", "start", "languages"])
      await service.answer(id, "Confirmed");
    await service.finishIntake();

    await service.startPrepareApplications();
    await firstSearchStarted;
    const stopping = service.stopBackgroundWork();
    releaseFirstSearch();
    const stopped = await stopping;
    expect(stopped.backgroundExecution).toMatchObject({
      state: "stopped",
      resumeSearch: "prepare",
    });
    expect(stopped.searchProgress).toMatchObject({
      stage: "stopped",
      target: 5,
      found: 0,
      baselineApplicationJobIds: [],
    });

    const continued = await service.continueBackgroundWork();
    expect(continued.backgroundExecution?.state).toBe("running");
    await expect
      .poll(async () => (await service.get()).searchProgress?.stage)
      .toBe("ready");
    const completed = await service.get();
    expect(completed.searchProgress).toMatchObject({ target: 5, found: 5 });
    expect(
      completed.applications.filter((application) => application.addedBy === "agent"),
    ).toHaveLength(5);
  });

  it("appends five unique jobs and preserves manual tracking outcomes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-more-jobs-"));
    const requestedExclusions: string[][] = [];
    const previouslySeenWithoutApplication =
      "https://jobs.example.test/previously-seen-without-application";
    const readyIncrementalResearch = {
      ...incrementalResearch,
      async research(
        workspace: JobSearchWorkspace,
        options?: { excludeApplyUrls?: string[] },
      ) {
        requestedExclusions.push(options?.excludeApplyUrls ?? []);
        const result = await incrementalResearch.research(workspace, options);
        return {
          ...result,
          seenUrls: [previouslySeenWithoutApplication],
          applications: result.applications.map((application) => ({
            ...application,
            status: "ready_to_send" as const,
            missingQuestions: [],
            formFields: application.formFields.map((field) => ({
              ...field,
              value: field.value || "Confirmed",
              confidence: 100,
            })),
          })),
        };
      },
    };
    const service = new JobSearchService(
      root,
      undefined,
      readyIncrementalResearch,
      deterministicCoverLetterWriter,
    );
    await service.initialize();
    await service.addSource({
      kind: "cv",
      name: "alex-chen-cv.md",
      content: "Alex Chen, platform engineer",
    });
    await service.updateProfile({
      name: "Alex Chen",
      email: "alex.chen@example.test",
    });
    for (const id of ["locations", "employment", "start", "languages"])
      await service.answer(id, "Confirmed answer");
    await service.finishIntake();
    const initial = await service.prepareApplications();
    expect(initial.applications).toHaveLength(5);
    const started = await service.startFindMoreApplications();
    expect(started.searchProgress).toMatchObject({
      stage: "looking",
      target: 5,
      found: 0,
    });
    await expect
      .poll(
        async () =>
          (await service.get()).applications.filter(
            (application) => application.addedBy === "agent",
          ).length,
      )
      .toBe(10);
    const expanded = await service.get();
    expect(
      expanded.applications.filter((application) => application.addedBy === "agent"),
    ).toHaveLength(10);
    expect(requestedExclusions[1]).not.toContain(
      previouslySeenWithoutApplication,
    );
    expect(requestedExclusions[1]).toHaveLength(10);
    expect(new Set(expanded.opportunities.map((job) => job.applyUrl)).size).toBe(
      10,
    );

    const rejectedId = expanded.applications[0].id;
    let tracked = await service.setApplicationOutcome(
      rejectedId,
      "rejected_by_user",
    );
    expect(tracked.applications[0].outcome).toBe("rejected_by_user");
    expect(
      await service.autofillByUrl(expanded.opportunities[0].applyUrl),
    ).not.toBeNull();
    tracked = await service.setApplicationOutcome(rejectedId, undefined);
    expect(tracked.applications[0].outcome).toBeUndefined();
    tracked = await service.setApplicationOutcome(
      tracked.applications[1].id,
      "unsuccessful",
    );
    expect(tracked.applications[1].outcome).toBe("unsuccessful");
  });

  it("promotes one benched job without replacing automated applications", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-promote-job-"));
    const service = serviceFor(root);
    await service.initialize();
    await service.addSource({ kind: "cv", name: "cv.txt", content: "Candidate" });
    await service.updateProfile({
      name: "Candidate",
      email: "candidate@example.test",
    });
    for (const id of ["locations", "employment", "start", "languages"])
      await service.answer(id, "Confirmed");
    await service.finishIntake();
    await service.updateSearchConfig({ discoveryTarget: 20, applicationTarget: 3 });

    const automated = await service.prepareApplications();
    expect(automated.applications).toHaveLength(3);
    const benched = automated.opportunities.find(
      (job) => !automated.applications.some((application) => application.jobId === job.id),
    )!;

    const promoted = await service.promoteOpportunity(benched.id);

    expect(promoted.applications).toHaveLength(4);
    expect(
      promoted.applications.find((application) => application.jobId === benched.id),
    ).toMatchObject({ addedBy: "user" });
    expect(promoted.applications.filter((application) => application.addedBy !== "user"))
      .toHaveLength(3);
  });

  it("refills failed application slots until five drafts are verified", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-refill-quota-"));
    let researchCalls = 0;
    const researchLimits: number[] = [];
    const makeJob = (id: string, fit: number): JobOpportunity => ({
      id,
      company: `${id} Employer`,
      title: `${id} Engineer`,
      location: "Remote",
      workplace: "Remote",
      compensation: "Not disclosed",
      sourceUrl: `https://jobs.example.test/${id}`,
      applyUrl: `https://jobs.example.test/${id}/apply`,
      capturedAt: "2026-07-18",
      fit,
      summary: `${id} role`,
      description: `${id} role`,
      requirements: [],
      requirementMatches: [],
      strengths: [],
      gaps: [],
    });
    const research = {
      async research(_workspace: JobSearchWorkspace, options: { limit: number }) {
        researchCalls += 1;
        researchLimits.push(options.limit);
        const count = researchCalls === 1 ? 5 : 3;
        const prefix = researchCalls === 1 ? "first" : "refill";
        const opportunities = Array.from({ length: count }, (_, index) =>
          makeJob(`${prefix}-${index}`, 90 - index),
        );
        return {
          opportunities,
          applications: [],
          seenUrls: opportunities.map((job) => job.applyUrl),
        };
      },
      async assess(
        _workspace: JobSearchWorkspace,
        opportunities: JobOpportunity[],
      ) {
        return opportunities;
      },
      async inspectApplications(
        workspace: JobSearchWorkspace,
        opportunities: JobOpportunity[],
      ) {
        return {
          applications: opportunities.map((job) => {
            const mapped =
              job.id.startsWith("refill-") ||
              job.id === "first-0" ||
              job.id === "first-1";
            return {
              id: `app-${job.id}`,
              jobId: job.id,
              status: mapped ? ("ready_to_send" as const) : ("needs_input" as const),
              coverLetter: "",
              coverLetterChat: [],
              formFields: mapped
                ? [
                    {
                      id: "name",
                      canonicalKey: "name",
                      externalName: "name",
                      label: "Full name",
                      type: "text" as const,
                      value: workspace.profile.name,
                      required: true,
                      source: "profile" as const,
                      confidence: 100,
                    },
                  ]
                : [],
              missingQuestions: mapped ? [] : ["Employer form requires manual review"],
              adapter: "generic" as const,
              liveFormValidated: mapped,
              formSchema: mapped
                ? {
                    observedQuestionCount: 1,
                    mappedQuestionCount: 1,
                    fingerprint: `schema-${job.id}`,
                    issues: [],
                    verifiedByAgent: true,
                  }
                : undefined,
              updatedAt: workspace.updatedAt,
            };
          }),
          failures: [] as JobResearchFailure[],
        };
      },
    };
    const service = new JobSearchService(
      root,
      undefined,
      research,
      deterministicCoverLetterWriter,
    );
    await service.initialize();
    await service.addSource({ kind: "cv", name: "cv.txt", content: "Candidate" });
    await service.updateProfile({
      name: "Candidate",
      email: "candidate@example.test",
    });
    for (const id of ["locations", "employment", "start", "languages"])
      await service.answer(id, "Confirmed");
    await service.finishIntake();

    const result = await service.prepareApplications();

    expect(researchCalls).toBe(2);
    expect(researchLimits).toEqual([26, 16]);
    expect(result.applications).toHaveLength(8);
    expect(
      result.applications.filter((application) => application.addedBy === "agent"),
    ).toHaveLength(5);
    expect(result.searchProgress).toMatchObject({
      stage: "ready",
      target: 5,
      found: 5,
      error: undefined,
    });
    expect(
      result.searchProgress?.items?.filter(
        (item) =>
          item.application === "passed" &&
          item.applicationVerification === "passed",
      ),
    ).toHaveLength(5);
  });

  it("drops only verifier-rejected vacancies and their application drafts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-verifier-filter-"));
    const research = {
      ...deterministicResearch,
      async assess(
        _workspace: JobSearchWorkspace,
        opportunities: JobOpportunity[],
      ) {
        return ["codex-core", "test-job-1"].includes(opportunities[0]?.id)
          ? opportunities
          : [];
      },
    };
    const service = new JobSearchService(
      root,
      undefined,
      research,
      deterministicCoverLetterWriter,
    );
    await service.initialize();
    await service.addSource({
      kind: "cv",
      name: "candidate-cv.txt",
      content: "Candidate Name, candidate@example.test, platform delivery",
    });
    await service.updateProfile({
      name: "Candidate Name",
      email: "candidate@example.test",
    });
    for (const id of ["locations", "employment", "start", "languages"])
      await service.answer(id, "Confirmed answer");
    await service.finishIntake();
    const staged = await service.prepareApplications();
    expect(staged.opportunities).toHaveLength(2);
    expect(staged.applications).toHaveLength(2);
    expect(staged.applications.map((item) => item.jobId)).toEqual(
      staged.opportunities.map((item) => item.id),
    );
  });

  it("revalidates the scored bench, drops closed jobs, and avoids new discovery when enough remain open", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-open-bench-"));
    let researchCalls = 0;
    let revalidationCalls = 0;
    const jobs: JobOpportunity[] = Array.from({ length: 11 }, (_, index) => ({
      id: `bench-${index}`,
      company: `Bench Employer ${index}`,
      title: `Bench Role ${index}`,
      location: "Remote",
      workplace: "Remote",
      compensation: "Not disclosed",
      sourceUrl: `https://jobs.example.test/bench/${index}`,
      applyUrl: `https://jobs.example.test/bench/${index}/apply`,
      capturedAt: "2026-07-29",
      fit: 100 - index,
      summary: `Bench role ${index}`,
      description: `Bench role ${index} requires platform experience.`,
      requirements: ["Platform experience"],
      requirementMatches: [],
      strengths: [],
      gaps: [],
    }));
    const closedJobId = "bench-10";
    const research = {
      async research() {
        researchCalls += 1;
        return {
          opportunities: jobs,
          applications: [] as ApplicationDraft[],
          failures: [] as JobResearchFailure[],
          seenUrls: jobs.map((job) => job.applyUrl),
        };
      },
      async revalidate(
        _workspace: JobSearchWorkspace,
        opportunities: JobOpportunity[],
      ) {
        revalidationCalls += 1;
        const closed = opportunities.find((job) => job.id === closedJobId)!;
        return {
          opportunities: opportunities.filter((job) => job.id !== closedJobId),
          failures: [
            {
              id: closed.id,
              company: closed.company,
              title: closed.title,
              location: closed.location,
              sourceUrl: closed.sourceUrl,
              applyUrl: closed.applyUrl,
              capturedAt: new Date().toISOString(),
              stage: "expired" as const,
              reason: "Vacancy is closed",
            },
          ],
        };
      },
      async assess(
        _workspace: JobSearchWorkspace,
        opportunities: JobOpportunity[],
      ) {
        return opportunities.map((job) => ({
          ...job,
          requirementMatches:
            job.requirementMatches.length > 0
              ? job.requirementMatches
              : [
                  {
                    id: `${job.id}-platform`,
                    kind: "required" as const,
                    requirement: "Platform experience",
                    status: "matched" as const,
                    explanation: "Verified candidate evidence supports it.",
                    evidence: [],
                  },
                ],
        }));
      },
      async inspectApplications(
        workspace: JobSearchWorkspace,
        opportunities: JobOpportunity[],
      ) {
        return {
          applications: opportunities.map(
            (job): ApplicationDraft => ({
              id: `app-${job.id}`,
              jobId: job.id,
              status: "ready_to_send",
              coverLetter: "",
              coverLetterChat: [],
              formFields: [
                {
                  id: "name",
                  canonicalKey: "name",
                  externalName: "name",
                  label: "Full name",
                  type: "text",
                  value: workspace.profile.name,
                  required: true,
                  source: "profile",
                  confidence: 100,
                },
              ],
              missingQuestions: [],
              adapter: "generic",
              liveFormValidated: true,
              formSchema: {
                observedQuestionCount: 1,
                mappedQuestionCount: 1,
                fingerprint: `schema-${job.id}`,
                issues: [],
                verifiedByAgent: true,
              },
              updatedAt: workspace.updatedAt,
            }),
          ),
          failures: [] as JobResearchFailure[],
        };
      },
    };
    const service = new JobSearchService(
      root,
      undefined,
      research,
      deterministicCoverLetterWriter,
    );
    await service.initialize();
    await service.addSource({ kind: "cv", name: "cv.txt", content: "Candidate" });
    await service.updateProfile({
      name: "Candidate",
      email: "candidate@example.test",
    });
    for (const id of ["locations", "employment", "start", "languages"])
      await service.answer(id, "Confirmed");
    await service.finishIntake();

    const first = await service.prepareApplications();
    expect(first.applications.filter((item) => item.addedBy === "agent")).toHaveLength(5);

    const next = await service.findMoreApplications();

    expect(revalidationCalls).toBe(1);
    expect(researchCalls).toBe(1);
    expect(next.applications.filter((item) => item.addedBy === "agent")).toHaveLength(10);
    expect(next.applications.some((item) => item.jobId === closedJobId)).toBe(false);
    expect(next.opportunities.some((item) => item.id === closedJobId)).toBe(false);
  });

  it("uses the verified bench before discovering unseen replacement jobs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-bench-"));
    const requestedExclusions: string[][] = [];
    let wave = 0;
    const makeJob = (index: number, prefix: string): JobOpportunity => ({
      id: `${prefix}-${index}`,
      company: `${prefix} Employer ${index}`,
      title: `Role ${index}`,
      location: "Remote",
      workplace: "Remote",
      compensation: "Not disclosed",
      sourceUrl: `https://jobs.example.test/${prefix}/${index}`,
      applyUrl: `https://jobs.example.test/${prefix}/${index}/apply`,
      capturedAt: "2026-07-15",
      fit: 90 - index,
      summary: `Role ${index}`,
      description: `Role ${index} requires reliable operations experience.`,
      requirements: [],
      requirementMatches: [],
      strengths: [],
      gaps: [],
    });
    const research = {
      async research(
        _workspace: JobSearchWorkspace,
        options?: { excludeApplyUrls?: string[] },
      ) {
        requestedExclusions.push(options?.excludeApplyUrls ?? []);
        const prefix = wave++ === 0 ? "first" : "second";
        const opportunities = Array.from({ length: prefix === "first" ? 7 : 3 }, (_, index) =>
          makeJob(index, prefix),
        );
        return {
          opportunities,
          applications: [],
          seenUrls: opportunities.map((job) => job.applyUrl),
        };
      },
      async revalidate(
        _workspace: JobSearchWorkspace,
        opportunities: JobOpportunity[],
      ) {
        return { opportunities, failures: [] as JobResearchFailure[] };
      },
      async assess(
        _workspace: JobSearchWorkspace,
        opportunities: JobOpportunity[],
      ) {
        return opportunities;
      },
      async inspectApplications(
        workspace: JobSearchWorkspace,
        opportunities: JobOpportunity[],
      ) {
        const applications = opportunities.map((job) => ({
          id: `app-${job.id}`,
          jobId: job.id,
          status: "needs_input" as const,
          coverLetter: "",
          coverLetterChat: [],
          formFields: [],
          missingQuestions: ["Employer form requires manual review"],
          adapter: "generic" as const,
          liveFormValidated: false,
          updatedAt: workspace.updatedAt,
        }));
        return { applications, failures: [] as JobResearchFailure[] };
      },
    };
    const service = new JobSearchService(
      root,
      undefined,
      research,
      deterministicCoverLetterWriter,
    );
    await service.initialize();
    await service.addSource({ kind: "cv", name: "cv.txt", content: "Candidate" });
    await service.updateProfile({ name: "Candidate", email: "candidate@example.test" });
    for (const id of ["locations", "employment", "start", "languages"])
      await service.answer(id, "Confirmed");
    await service.finishIntake();
    await service.updateSearchConfig({ discoveryTarget: 20, applicationTarget: 5 });
    let result = await service.prepareApplications();
    expect(result.applications).toHaveLength(10);
    expect(result.opportunities).toHaveLength(10);
    expect(result.searchProgress?.stage).toBe("ready");
    expect(result.discoveryNeedsRun).toBe(false);
    expect(result.searchProgress?.items).toHaveLength(10);
    expect(result.jobHistory).toHaveLength(10);
    expect(
      result.searchProgress?.items?.every((item) => Boolean(item.jobNumber)),
    ).toBe(true);
    expect(
      result.searchProgress?.items?.filter(
        (item) => item.application === "failed",
      ),
    ).toHaveLength(10);
    expect(
      result.searchProgress?.items?.filter(
        (item) => item.application === "bench",
      ),
    ).toHaveLength(0);
    expect(
      result.searchProgress?.items?.filter(
        (item) => item.applicationVerification === "passed",
      ),
    ).toHaveLength(0);
    expect(
      result.searchProgress?.items?.filter(
        (item) => item.applicationVerification === "failed",
      ),
    ).toHaveLength(10);
    expect(result.searchProgress).toMatchObject({
      found: 0,
      error: expect.stringContaining("Prepared 0 of 5"),
    });
    expect(
      result.opportunities.filter(
        (job) => !result.applications.some((application) => application.jobId === job.id),
      ),
    ).toHaveLength(0);
    result = await service.updateProfile({ phone: "+421 900 555 111" });
    expect(result.discoveryNeedsRun).toBe(true);
    result = await service.findMoreApplications();
    expect(result.discoveryNeedsRun).toBe(false);
    expect(result.applications).toHaveLength(10);
    expect(result.opportunities).toHaveLength(10);
    const historyCount = result.jobHistory.length;
    expect(historyCount).toBeGreaterThan(7);
    expect(requestedExclusions[1]).toContain(
      "https://jobs.example.test/first/0/apply",
    );
    expect(result.seenJobUrls.length).toBeGreaterThan(0);
  });

  it("resets the complete job list while preserving the candidate and evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-reset-jobs-"));
    const service = serviceFor(root);
    await service.initialize();
    await service.addSource({
      kind: "cv",
      name: "candidate-cv.txt",
      content: "Candidate Name\ncandidate@example.test\nPlatform engineer",
    });
    await service.updateProfile({
      name: "Candidate Name",
      email: "candidate@example.test",
      location: "Bratislava, Slovakia",
    });
    const before = await service.addOpportunity({
      company: "Before Reset",
      title: "Platform Engineer",
      applyUrl: "https://jobs.example.test/before-reset",
    });
    expect(before.opportunities[0].jobNumber).toBe(1);

    const reset = await service.resetJobList();
    expect(reset.profile).toMatchObject({
      name: "Candidate Name",
      email: "candidate@example.test",
      location: "Bratislava, Slovakia",
    });
    expect(reset.sources).toHaveLength(1);
    expect(reset.opportunities).toEqual([]);
    expect(reset.applications).toEqual([]);
    expect(reset.rejectedOpportunities).toEqual([]);
    expect(reset.jobHistory).toEqual([]);
    expect(reset.seenJobUrls).toEqual([]);
    expect(reset.searchProgress).toBeUndefined();
    expect(reset.discoveryNeedsRun).toBe(true);

    const after = await service.addOpportunity({
      company: "After Reset",
      title: "Protocol Engineer",
      applyUrl: "https://jobs.example.test/after-reset",
    });
    expect(after.opportunities[0].jobNumber).toBe(1);
  });

  it("completely resets the user, including persisted evidence and uploaded files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-reset-user-"));
    const service = serviceFor(root);
    await service.initialize();
    const initial = await service.get();
    await service.addSource({
      kind: "cv",
      name: "private-cv.txt",
      dataBase64: Buffer.from(
        "Private Candidate\nprivate@example.test\nProtocol engineer",
      ).toString("base64"),
      mimeType: "text/plain",
    });
    await service.updateProfile({
      name: "Private Candidate",
      email: "private@example.test",
      location: "Bratislava, Slovakia",
    });
    await service.addOpportunity({
      company: "Private Employer",
      title: "Protocol Engineer",
      applyUrl: "https://jobs.example.test/private-role",
    });

    const candidateDirectory = path.join(root, "job-search", "candidates");
    const filesDirectory = path.join(root, "job-search", "files");
    const runsDirectory = path.join(root, "job-search", "runs");
    const sourceSnapshotsDirectory = path.join(
      root,
      "job-search",
      "source-snapshots",
    );
    const analysisCheckpointsDirectory = path.join(
      root,
      "job-search",
      "analysis-checkpoints",
    );
    const knowledgeDirectory = path.join(
      runsDirectory,
      initial.candidateId,
      "knowledge",
    );
    await mkdir(knowledgeDirectory, { recursive: true });
    await writeFile(path.join(knowledgeDirectory, "private.md"), "private knowledge");
    await writeFile(
      path.join(candidateDirectory, `${initial.candidateId}.pre-private.json`),
      "{}",
    );
    await writeFile(path.join(candidateDirectory, "retired-candidate.json"), "{}");
    await mkdir(
      path.join(sourceSnapshotsDirectory, initial.candidateId, "source-private"),
      { recursive: true },
    );
    await writeFile(
      path.join(
        sourceSnapshotsDirectory,
        initial.candidateId,
        "source-private",
        "content.txt",
      ),
      "private source snapshot",
    );
    await mkdir(
      path.join(analysisCheckpointsDirectory, initial.candidateId, "reader-v1"),
      { recursive: true },
    );
    await writeFile(
      path.join(
        analysisCheckpointsDirectory,
        initial.candidateId,
        "reader-v1",
        "chunk.json",
      ),
      "{}",
    );

    const stopped = await service.stopBackgroundWork();
    expect(stopped.backgroundExecution?.state).toBe("stopped");

    const reset = await service.resetUserCompletely();

    expect(reset.candidateId).toBe(initial.candidateId);
    expect(reset.phase).toBe("intake");
    expect(reset.profileCompleteness).toBe(0);
    expect(reset.profile).toMatchObject({
      name: "",
      email: "",
      phone: "",
      linkedin: "",
      github: "",
      website: "",
      location: "",
      headline: "",
      summary: "",
      skills: [],
    });
    expect(reset.finalCv).toBe("");
    expect(reset.sources).toEqual([]);
    expect(reset.questions.every((question) => question.answer === "")).toBe(true);
    expect(reset.opportunities).toEqual([]);
    expect(reset.applications).toEqual([]);
    expect(reset.rejectedOpportunities).toEqual([]);
    expect(reset.jobHistory).toEqual([]);
    expect(reset.seenJobUrls).toEqual([]);
    expect(reset.sharedAnswers).toEqual({});
    expect(reset.discoveryNeedsRun).toBe(true);
    expect(reset.backgroundExecution?.state).not.toBe("stopped");
    expect(await readdir(filesDirectory)).toEqual([]);
    expect(await readdir(runsDirectory)).toEqual([]);
    expect(await readdir(sourceSnapshotsDirectory)).toEqual([]);
    expect(await readdir(analysisCheckpointsDirectory)).toEqual([]);
    expect(await readdir(candidateDirectory)).toEqual([
      `${initial.candidateId}.json`,
    ]);
    expect(
      JSON.parse(
        await readFile(path.join(root, "job-search", "job-numbers.json"), "utf8"),
      ),
    ).toEqual({ version: 2, nextJobNumber: 1, byKey: {} });
  });

  it("retains failed vacancy links and reasons even when nothing passes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-failures-"));
    const failure: JobResearchFailure = {
      id: "failed-1",
      company: "Closed Employer",
      title: "Closed role",
      location: "Remote",
      sourceUrl: "https://jobs.example.test/closed",
      applyUrl: "https://jobs.example.test/closed/apply",
      stage: "expired",
      reason: "Vacancy valid-through date has passed",
      capturedAt: new Date().toISOString(),
    };
    const service = new JobSearchService(
      root,
      undefined,
      {
        async research() {
          return {
            opportunities: [],
            applications: [],
            failures: [failure],
            seenUrls: [failure.sourceUrl],
          };
        },
      },
      deterministicCoverLetterWriter,
    );
    await service.initialize();
    const result = await service.prepareApplications();
    expect(result.rejectedOpportunities).toEqual([
      expect.objectContaining({
        ...failure,
        disposition: "rejected",
        reasonCode: "closed_or_unavailable",
      }),
    ]);
    expect(result.rejectedOpportunities[0].jobNumber).toBeTypeOf("number");
    expect(result.seenJobUrls).toContain(failure.sourceUrl);
    expect(result.applications).toEqual([]);
  });

  it("routes blocked and technical verification failures away from confirmed rejections", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-review-"));
    const failures: JobResearchFailure[] = [
      {
        id: "blocked-1",
        company: "Blocked Employer",
        title: "Blocked role",
        location: "Remote",
        sourceUrl: "https://jobs.example.test/blocked",
        applyUrl: "https://jobs.example.test/blocked",
        stage: "vacancy_validation",
        reason: "Job page returned 403",
        capturedAt: new Date().toISOString(),
      },
      {
        id: "timeout-1",
        company: "Slow Employer",
        title: "Slow role",
        location: "Remote",
        sourceUrl: "https://jobs.example.test/timeout",
        applyUrl: "https://jobs.example.test/timeout",
        stage: "vacancy_validation",
        reason: "page.goto timed out after 20000ms",
        capturedAt: new Date().toISOString(),
      },
      {
        id: "source-1",
        company: "Job Board",
        title: "Open positions",
        location: "Remote",
        sourceUrl: "https://jobs.example.test/list",
        applyUrl: "https://jobs.example.test/list",
        stage: "vacancy_validation",
        reason: "Vacancy list contained no independently validated current positions",
        capturedAt: new Date().toISOString(),
      },
    ];
    const service = new JobSearchService(
      root,
      undefined,
      {
        async research() {
          return { opportunities: [], applications: [], failures };
        },
      },
      deterministicCoverLetterWriter,
    );
    await service.initialize();
    const result = await service.prepareApplications();
    expect(result.rejectedOpportunities).toEqual([]);
    expect(
      Object.fromEntries(
        result.searchValidationIssues.map((failure) => [
          failure.id,
          failure.disposition,
        ]),
      ),
    ).toEqual({
      "blocked-1": "manual_review",
      "timeout-1": "unresolved",
      "source-1": "source_page",
    });
    expect(result.opportunities).toEqual([]);
  });

  it("revalidates persisted search history without matching or preparing applications", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-replay-"));
    const seedService = new JobSearchService(root);
    await seedService.initialize();
    const seed = await seedService.get();
    const existing = (await deterministicResearch.research(seed)).opportunities[0];
    const existingApplication = (
      await deterministicResearch.research(seed)
    ).applications[0];
    seed.opportunities = [existing];
    seed.applications = [existingApplication];
    seed.jobHistory = [
      {
        id: "live-again",
        jobNumber: 101,
        company: "Live Again",
        title: "Platform Architect",
        sourceUrl: "https://jobs.example.test/live-again",
        validation: "failed",
        match: "waiting",
        application: "waiting",
        applicationVerification: "waiting",
        reason: "Old verifier failure",
      },
      {
        id: "still-closed",
        jobNumber: 102,
        company: "Closed",
        title: "Closed Architect",
        sourceUrl: "https://jobs.example.test/still-closed",
        validation: "failed",
        match: "waiting",
        application: "waiting",
        applicationVerification: "waiting",
        reason: "Old verifier failure",
      },
    ];
    await writeFile(
      path.join(root, "job-search", "candidates", "candidate-1.json"),
      `${JSON.stringify(seed, null, 2)}\n`,
      "utf8",
    );

    let expansionLimit = 0;
    const replayService = new JobSearchService(root, undefined, {
      async research() {
        throw new Error("Discovery must not run during validation replay");
      },
      async revalidate(_workspace, opportunities, onProgress, options) {
        expansionLimit = options?.expansionLimit ?? 0;
        for (const opportunity of opportunities) {
          await onProgress?.({
            item: {
              id: opportunity.id,
              company: opportunity.company,
              title: opportunity.title,
              sourceUrl: opportunity.sourceUrl,
            },
            phase: "validation",
            state:
              opportunity.id === "still-closed" ? "failed" : "passed",
            reason:
              opportunity.id === "still-closed"
                ? "Current page confirms the vacancy is closed"
                : undefined,
          });
        }
        return {
          opportunities: opportunities.filter(
            (opportunity) => opportunity.id !== "still-closed",
          ),
          failures: [
            {
              id: "still-closed",
              jobNumber: 102,
              company: "Closed",
              title: "Closed Architect",
              location: "Remote",
              sourceUrl: "https://jobs.example.test/still-closed",
              applyUrl: "https://jobs.example.test/still-closed",
              stage: "expired",
              reason: "Current page confirms the vacancy is closed",
              capturedAt: new Date().toISOString(),
            },
          ],
        };
      },
    });
    await replayService.initialize();
    const result = await replayService.revalidateSearchHistory();

    expect(expansionLimit).toBe(10);
    expect(result.applications).toEqual([existingApplication]);
    expect(result.opportunities).toHaveLength(1);
    expect(result.opportunities[0]).toMatchObject({
      id: existing.id,
      title: existing.title,
      requirementMatches: existing.requirementMatches,
    });
    expect(result.jobHistory.find((item) => item.id === "live-again"))
      .toMatchObject({ validation: "passed", reason: undefined });
    expect(result.jobHistory.find((item) => item.id === "still-closed"))
      .toMatchObject({
        validation: "failed",
        reason: "Current page confirms the vacancy is closed",
      });
    expect(result.searchProgress?.activity).toContain(
      "Validation replay complete",
    );
  });

  it("coalesces board and canonical ATS records before search revalidation", () => {
    const boardRecord: JobOpportunity = {
      id: "board-record",
      jobNumber: 38,
      company: "CertiK",
      title: "Blockchain Security Engineer",
      location: "Remote",
      workplace: "Remote",
      compensation: "Not disclosed",
      sourceUrl: "https://board.example/jobs/certik-security",
      applyUrl: "https://jobs.lever.co/certik/job-123?ref=board",
      capturedAt: "2026-07-17",
      fit: 0,
      summary: "Board copy",
      description: "Board copy says remote.",
      requirements: [],
      requirementMatches: [],
      strengths: [],
      gaps: [],
    };
    const canonicalRecord: JobOpportunity = {
      ...boardRecord,
      id: "canonical-record",
      location: "US / Remote",
      sourceUrl: "https://jobs.lever.co/certik/job-123",
      applyUrl: "https://jobs.lever.co/certik/job-123",
      description: "",
    };

    expect(
      coalesceSearchVerificationSeeds([boardRecord, canonicalRecord]),
    ).toEqual([canonicalRecord]);
  });

  it("keeps permanent job numbers across service restarts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-job-numbers-"));
    const service = serviceFor(root);
    await service.initialize();
    const first = await service.addOpportunity({
      company: "First Employer",
      title: "First Role",
      applyUrl: "https://jobs.example.test/permanent/first",
    });
    const firstNumber = first.opportunities[0].jobNumber!;
    const samePageDifferentRole = await service.addOpportunity({
      company: "First Employer",
      title: "Different Role On The Same Careers Page",
      applyUrl: "https://jobs.example.test/permanent/first",
    });
    const samePageNumber = samePageDifferentRole.opportunities.find(
      (job) => job.title === "Different Role On The Same Careers Page",
    )!.jobNumber!;
    expect(samePageNumber).toBeGreaterThan(firstNumber);
    expect(samePageDifferentRole.applications).toHaveLength(2);
    expect(
      samePageDifferentRole.jobHistory.filter(
        (item) => item.sourceUrl === "https://jobs.example.test/permanent/first",
      ),
    ).toHaveLength(2);

    const second = await service.addOpportunity({
      company: "Second Employer",
      title: "Second Role",
      applyUrl: "https://jobs.example.test/permanent/second",
    });
    const secondNumber = second.opportunities.find(
      (job) => job.title === "Second Role",
    )!.jobNumber!;
    expect(secondNumber).toBeGreaterThan(samePageNumber);

    const restarted = serviceFor(root);
    await restarted.initialize();
    expect(
      (await restarted.get()).opportunities.find(
        (job) => job.title === "Second Role",
      )?.jobNumber,
    ).toBe(secondNumber);
  });

  it("saves only reusable facts and tracks applied status manually", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-candidates-"));
    const service = serviceFor(root);
    await service.initialize();
    const candidate = await service.updateProfile({
      name: "Nina Novak",
      email: "nina@example.test",
      location: "Bratislava",
    });
    await service.addSource({
      kind: "cv",
      name: "nina-novak-cv.md",
      content: "Nina Novak CV",
    });
    for (const id of ["locations", "employment", "start", "languages"])
      await service.answer(id, "Confirmed answer");
    await service.finishIntake();
    await service.prepareApplications();
    const withExtra = await service.addOpportunity({
      company: "Acme",
      title: "Platform Engineer",
      applyUrl: "https://jobs.example.com/platform",
    });
    expect(withExtra.applications).toHaveLength(6);
    const app = withExtra.applications.find((item) =>
      item.jobId.startsWith("custom-"),
    )!;
    await service.updateApplication(app.id, {
      fields: {
        linkedin: "https://linkedin.com/in/nina",
        phone: "+421 900 111 222",
        authorization: "Authorized to work in the EU",
        salary: "Open to the role's budgeted range",
      },
    });
    const resolved = await service.resolveApplicationByUrl(
      "https://jobs.example.com/platform",
    );
    expect(resolved).toMatchObject({
      candidateId: candidate.candidateId,
      applicationId: app.id,
    });
    const updated = await service.get();
    expect(updated.profile.phone).toBe("+421 900 111 222");
    expect(updated.profile.linkedin).toBe("https://linkedin.com/in/nina");
    expect(updated.profile.workAuthorization).toBe("Authorized to work in the EU");
    expect(updated.sharedAnswers.phone).toBe("+421 900 111 222");
    expect(updated.sharedAnswers.linkedin).toBe("https://linkedin.com/in/nina");
    expect(updated.sharedAnswers).not.toHaveProperty("salary");
    expect(updated.sharedAnswers).not.toHaveProperty("why");
    const tracked = await service.setApplicationOutcome(app.id, "applied_waiting");
    expect(tracked.applications.find((item) => item.id === app.id)?.outcome).toBe(
      "applied_waiting",
    );
    expect(
      (await service.get()).applications.find((item) => item.id === app.id)?.outcome,
    ).toBe("applied_waiting");
  });

  it("does not save application-specific narrative or compensation answers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-fact-boundary-"));
    const service = serviceFor(root);
    await service.initialize();
    const workspace = await service.addOpportunity({
      company: "Acme",
      title: "Engineer",
      applyUrl: "https://jobs.example.com/engineer",
    });
    const app = workspace.applications[0];
    const result = await service.updateApplication(app.id, {
      fields: {
        phone: "+421900123456",
        why: "This motivation is specific to Acme.",
        salary: "EUR 140000",
      },
    });
    expect(result.sharedAnswers.phone).toBe("+421900123456");
    expect(result.sharedAnswers).not.toHaveProperty("why");
    expect(result.sharedAnswers).not.toHaveProperty("salary");
  });

  it("normalizes compensation currencies and uses the low end of ranges", () => {
    const workspace = {
      profile: { salaryExpectation: "CZK 100000" },
    } as JobSearchWorkspace;
    const rates = {
      EUR: 1,
      CZK: 0.04,
      USD: 0.9,
      GBP: 1.16,
      CHF: 1.04,
      PLN: 0.23,
      CAD: 0.66,
      AUD: 0.59,
    };
    expect(meetsCompensationFloor("EUR 90000 per year", workspace, rates)).toBe(
      true,
    );
    workspace.profile.salaryExpectation = "EUR 100000";
    expect(meetsCompensationFloor("EUR 90000 per year", workspace, rates)).toBe(
      false,
    );
    expect(
      meetsCompensationFloor("50 - 150 USD/Hr", workspace, rates),
    ).toBe(false);
    expect(
      meetsCompensationFloor("60 - 150 USD/Hr", workspace, rates),
    ).toBe(true);
    expect(parseCompensationRanges("50 - 150 USD/Hr")[0].minimum).toBe(50);
  });

  it("isolates explicit qualifications from flattened vacancy responsibilities", () => {
    const vacancy =
      "About Feldera What You’ll Do Own and evolve control plane services that orchestrate pipelines across diverse customer environments. " +
      "Minimum Requirements Strong proficiency in Rust. Experience building production backend APIs and distributed systems. " +
      "Hands-on Kubernetes experience. Candidates must have authorization to work in Europe. " +
      "Working at Feldera We are a distributed team with generous benefits.";
    const qualifications = extractQualificationSection(vacancy);
    const responsibilities = extractResponsibilitiesSection(vacancy);
    expect(qualifications).toContain("Strong proficiency in Rust");
    expect(qualifications).toContain("Hands-on Kubernetes experience");
    expect(qualifications).not.toContain("Own and evolve control plane");
    expect(qualifications).not.toContain("Working at Feldera");
    expect(responsibilities).toContain("Own and evolve control plane services");
    expect(responsibilities).not.toContain("Minimum Requirements");
    expect(
      requirementIsExplicitQualification(
        "Strong proficiency in Rust",
        qualifications,
      ),
    ).toBe(true);
    expect(
      requirementIsExplicitQualification(
        "Own and evolve control plane services across customer environments",
        qualifications,
      ),
    ).toBe(false);
  });

  it("uses the specification scoring components for typed requirement matches", () => {
    expect(
      calculateRequirementFit([
        {
          id: "rust",
          kind: "required",
          category: "mandatory",
          requirement: "Strong proficiency in Rust",
          status: "matched",
          matchClass: "explicit",
          confidence: 1,
          importanceWeight: 3,
          credit: 1,
          gapClass: "none",
          gapSeverity: "none",
          explanation: "Exact evidence",
          evidence: [
            {
              claimId: "claim-rust",
              sourceId: "cv",
              sourceName: "CV",
              excerpt: "Strong proficiency in Rust",
              claimConfidence: 1,
            },
          ],
        },
      ]),
    ).toBe(90);
    expect(
      calculateOpportunityConfidence({
        sourceConfidence: 0.95,
        hasApplicationPath: true,
        descriptionComplete: true,
        statusConsistent: true,
        hasPublishedDate: true,
        riskSignalCount: 0,
      }),
    ).toBe(0.983);
  });

  it("selects the top eligible jobs and excludes weak watchlist matches", () => {
    const jobs = [
      ["a1", "Acme", "apply_now"],
      ["a2", "Acme", "credible_adjacent"],
      ["a3", "Acme", "apply_now"],
      ["watch", "Beta", "watchlist"],
      ["b1", "Beta", "apply_now"],
    ].map(([id, company, portfolioCategory], index) => ({
      id,
      company,
      title: id,
      location: "Remote",
      workplace: "Remote",
      compensation: "Not disclosed",
      sourceUrl: `https://example.test/${id}`,
      applyUrl: `https://example.test/${id}/apply`,
      capturedAt: "2026-07-17",
      fit: id === "watch" ? 24 : 90 - index,
      summary: id,
      requirements: [],
      requirementMatches: [],
      strengths: [],
      gaps: [],
      portfolioCategory,
      feasibilityGate: { status: "passed", reasons: [] },
    })) as JobOpportunity[];
    expect(selectPhase2ApplicationPortfolio(jobs, 5).map((job) => job.id)).toEqual([
      "a1",
      "a2",
      "a3",
      "b1",
    ]);
  });

  it("accepts affirmative remote vacancies for a remote candidate without using current residence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rolegain-workplace-"));
    const service = serviceFor(root);
    await service.initialize();
    await service.updateProfile({ location: "Kosice, Slovakia" });
    await service.answer("locations", "Remote");
    const remote = await service.get();
    const job = (
      overrides: Partial<Parameters<typeof matchesWorkplace>[0]>,
    ): Parameters<typeof matchesWorkplace>[0] => ({
        id: "job",
        title: "Protocol Engineer",
        jobUrl: "https://jobs.example.test/job",
        applyUrl: "https://jobs.example.test/job/apply",
        ...overrides,
      });
    expect(discoveryWorkIntent(remote)).not.toHaveProperty("currentLocation");
    expect(
      matchesWorkplace(
        job({ location: "Europe", workplaceType: "Remote", isRemote: true }),
        remote,
      ),
    ).toBe(true);
    expect(
      matchesWorkplace(
        job({ location: "United States", workplaceType: "Remote", isRemote: true }),
        remote,
      ),
    ).toBe(true);
    expect(
      matchesWorkplace(
        job({
          location: "France",
          workplaceType: "Remote",
          isRemote: true,
          descriptionPlain:
            "Location Remote (US or EU, up to GMT+2 to ensure sufficient overlap with the rest of the team).",
        }),
        remote,
      ),
    ).toBe(true);
    expect(
      matchesWorkplace(
        job({
          location: "France",
          workplaceType: "Remote",
          isRemote: true,
          descriptionPlain: "This position is remote in France only.",
        }),
        remote,
      ),
    ).toBe(true);
    expect(
      matchesWorkplace(
        job({
          location: "United States",
          workplaceType: "Remote",
          isRemote: true,
          descriptionPlain:
            "Our remote team collaborates every day with colleagues in the EU.",
        }),
        remote,
      ),
    ).toBe(true);
    expect(
      matchesWorkplace(
        job({ location: "Remote" }),
        remote,
      ),
    ).toBe(true);
    expect(
      matchesWorkplace(
        job({
          location: "New York (Hybrid)",
          descriptionPlain:
            "This full-time role can be performed remotely through an EOR outside the US.",
        }),
        remote,
      ),
    ).toBe(true);
    expect(
      matchesWorkplace(
        job({
          location: "Berlin, Germany",
          workplaceType: "On-site",
          descriptionPlain: "This is not a remote role.",
        }),
        remote,
      ),
    ).toBe(false);
    expect(
      reconcileRemoteLocation({
        location: "France",
        workplaceType: "Remote",
        isRemote: true,
        descriptionPlain:
          "Location Remote (US or EU, up to GMT+2 to ensure sufficient overlap with the rest of the team).",
      }),
    ).toBe(
      "Location Remote (US or EU, up to GMT+2 to ensure sufficient overlap with the rest of the team).",
    );
    expect(
      matchesWorkplace(
        job({ location: "Kosice, Slovakia", workplaceType: "On-site" }),
        remote,
      ),
    ).toBe(false);

    await service.answer("locations", "Hybrid: Berlin, Germany");
    const hybrid = await service.get();
    expect(discoveryWorkIntent(hybrid)).toMatchObject({
      workplaceModes: ["Hybrid"],
      willingWorkLocations: ["Berlin, Germany"],
      remoteEligibility: [],
    });
    expect(
      matchesWorkplace(
        job({ location: "Berlin, Germany", workplaceType: "Hybrid" }),
        hybrid,
      ),
    ).toBe(true);
    expect(
      matchesWorkplace(
        job({ location: "Munich, Germany", workplaceType: "Hybrid" }),
        hybrid,
      ),
    ).toBe(false);
  });

  it("builds the public Greenhouse API fallback for blocked job-board pages", () => {
    expect(
      greenhouseJobApiUrl(
        "https://job-boards.greenhouse.io/coinbase/jobs/7366208",
      ),
    ).toBe(
      "https://boards-api.greenhouse.io/v1/boards/coinbase/jobs/7366208",
    );
    expect(
      greenhouseJobApiUrl("https://jobs.ashbyhq.com/example/job-id"),
    ).toBe("");
  });

  it("leaves an unsupported demographic select blank", () => {
    const field: ApplicationDraft["formFields"][number] = {
      id: "gender",
      canonicalKey: "eeoc_gender",
      label: "Gender",
      type: "select",
      value: "",
      required: false,
      source: "profile",
      confidence: 0,
      options: ["Man", "Woman", "Non-binary", "Decline to self-identify"],
    };
    expect(compatibleCandidateValue(field, "Male")).toBe("");
    expect(compatibleCandidateValue(field, "Man")).toBe("Man");
  });
});
