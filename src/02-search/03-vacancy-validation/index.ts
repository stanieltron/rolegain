import { createHash } from "node:crypto";
import { type Browser, type Page } from "playwright";
import type { JobOpportunity, JobResearchFailure, JobSearchWorkspace } from "../../contracts/job-search.js";
import type { CodexExecClient } from "../../codex-runtime/client.js";
import { assertPublicHttpUrl } from "../../infrastructure/public-http.js";
import { normalizeExtractedText, repairMojibake } from "../../infrastructure/text-encoding.js";
import {
  extractVacancyLeadsFromListing,
  interpretationFromStructuredData,
  interpretVacancySnapshot,
  structuredVacancyIsComplete,
  validateVacancyInterpretation,
  type ListingVacancyLead,
  type VacancyInterpretation,
  type VacancyPageSnapshot,
} from "./interpreter.js";
import type { BrowserPool } from "../../search-match-shared/browser-pool.js";
import {
  authoritativeSourceConfidence,
  calculateOpportunityConfidence,
  candidateFromOpportunity,
  extractCompensation,
  extractQualificationSection,
  extractResponsibilitiesSection,
  failureFromOpportunity,
  matchesWorkplace,
  normalizeCompensationText,
  normalizeOpportunityUrl,
  reconcileRemoteLocation,
  summarize,
  validationRiskSignals,
} from "../../search-match-shared/opportunity.js";
import { progressItemFromOpportunity } from "../../search-match-shared/progress.js";
import { discoveryWorkIntent } from "../../search-match-shared/search-intent.js";
import {
  mapParallelOrdered,
  vacancyValidationConcurrency,
} from "../../search-match-shared/parallel.js";
import type { LiveCandidate, OpportunityProgressReporter } from "../../search-match-shared/types.js";

export async function revalidateOpportunities(input: {
  codex: CodexExecClient;
  cwd: string;
  browsers: BrowserPool;
  workspace: JobSearchWorkspace;
  opportunities: JobOpportunity[];
  onProgress?: OpportunityProgressReporter;
  expansionLimit?: number;
}): Promise<{ opportunities: JobOpportunity[]; failures: JobResearchFailure[] }> {
  const {
    codex,
    cwd,
    browsers,
    workspace,
    opportunities,
    onProgress,
    expansionLimit = 1,
  } = input;
  if (!codex) return { opportunities, failures: [] };
  const executionGeneration = browsers.currentGeneration(workspace.candidateId);
  const browser = await browsers.launch.bind(browsers)(
    workspace.candidateId,
    executionGeneration,
  );
  try {
    const results = await mapParallelOrdered(
      opportunities,
      vacancyValidationConcurrency(),
      async (opportunity) => {
          await onProgress?.({
            item: progressItemFromOpportunity(opportunity),
            phase: "validation",
            state: "running",
          });
          try {
            const resolvedCandidates = await resolveDiscoveredJobs(
              browser,
              candidateFromOpportunity(opportunity),
              codex,
              cwd,
              workspace,
              expansionLimit,
            );
            if (!resolvedCandidates.length)
              throw new Error("Vacancy no longer resolves to a current job");
            const candidates = resolvedCandidates.filter((candidate) =>
              matchesWorkplace(candidate.job, workspace),
            );
            if (!candidates.length)
              throw new Error("Workplace or location does not match the candidate constraint");
            await onProgress?.({
              item: progressItemFromOpportunity(opportunity),
              phase: "validation",
              state: "passed",
            });
            const validatedAt = new Date().toISOString();
            return {
              opportunities: candidates.map((candidate) => {
                const description =
                  candidate.job.descriptionPlain || opportunity.description || "";
                const compensation =
                  normalizeCompensationText(candidate.job.compensation || "") ||
                  extractCompensation(description) ||
                  opportunity.compensation;
                const sourceConfidence = authoritativeSourceConfidence(
                  candidate.job.jobUrl,
                  candidate.job.applyUrl,
                );
                const riskSignals = validationRiskSignals(candidate.job);
                const expanded = candidates.length > 1;
                return {
                  ...opportunity,
                  id: expanded ? candidate.job.id : opportunity.id,
                  jobNumber: expanded ? undefined : opportunity.jobNumber,
                  company: candidate.company,
                  title: candidate.job.title,
                  location: candidate.job.location || opportunity.location,
                  workplace:
                    candidate.job.workplaceType || opportunity.workplace,
                  compensation: compensation || "Not disclosed",
                  sourceUrl: candidate.job.jobUrl,
                  applyUrl: candidate.job.applyUrl,
                  summary: summarize(description),
                  description,
                  lastValidatedAt: validatedAt,
                  opportunityConfidence: calculateOpportunityConfidence({
                    sourceConfidence,
                    hasApplicationPath:
                      normalizeOpportunityUrl(candidate.job.applyUrl) !==
                        normalizeOpportunityUrl(candidate.job.jobUrl) ||
                      /\/application|\/apply\b/i.test(candidate.job.applyUrl),
                    descriptionComplete: description.length >= 500,
                    statusConsistent: candidate.job.isListed !== false,
                    hasPublishedDate: Boolean(candidate.job.publishedAt),
                    riskSignalCount: riskSignals.length,
                  }),
                  validation: {
                    status: "live",
                    sourceConfidence,
                    retrievedAt: validatedAt,
                    descriptionFingerprint: createHash("sha256")
                      .update(description)
                      .digest("hex"),
                    responsibilitiesText:
                      extractResponsibilitiesSection(description),
                    qualificationsText:
                      extractQualificationSection(description),
                    riskSignals,
                  },
                } as JobOpportunity;
              }),
            };
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const failure = failureFromOpportunity(
              opportunity,
              /closed|expired|no longer/i.test(reason) ? "expired" : "vacancy_validation",
              reason,
            );
            await onProgress?.({
              item: progressItemFromOpportunity(opportunity),
              phase: "validation",
              state: "failed",
              reason,
              validationDisposition: failure.disposition,
            });
            return { failure };
          }
      },
    );
    return {
      opportunities: results.flatMap((item) => item.opportunities ?? []),
      failures: results
        .map((item) => item.failure)
        .filter((item): item is JobResearchFailure => Boolean(item)),
    };
  } finally {
    await browsers.close(browser);
  }
}

export async function resolveDiscoveredJobs(
  browser: Browser,
  candidate: LiveCandidate,
  codex: CodexExecClient,
  cwd: string,
  workspace: JobSearchWorkspace,
  limit: number,
  depth = 0,
): Promise<LiveCandidate[]> {
  await assertPublicHttpUrl(new URL(candidate.job.jobUrl));
  const page = await browser.newPage({ serviceWorkers: "block" });
  try {
    await guardPublicPage(page);
    let response;
    let recoveredNavigation = false;
    try {
      response = await page.goto(candidate.job.jobUrl, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
    } catch (error) {
      if (!/Download is starting/i.test(String(error))) throw error;
      recoveredNavigation = true;
    }
    if (response?.status() === 403) {
      const canonicalGreenhouseUrl = await resolveGreenhouseCanonicalJobUrl(
        candidate.job.jobUrl,
      );
      if (
        canonicalGreenhouseUrl &&
        normalizeOpportunityUrl(canonicalGreenhouseUrl) !==
          normalizeOpportunityUrl(candidate.job.jobUrl)
      ) {
        await assertPublicHttpUrl(new URL(canonicalGreenhouseUrl));
        response = await page.goto(canonicalGreenhouseUrl, {
          waitUntil: "domcontentloaded",
          timeout: 20_000,
        });
      }
    }
    await page
      .waitForLoadState("networkidle", { timeout: 5_000 })
      .catch(() => undefined);
    const pageExposesVacancy = await pageExposesCandidateVacancy(
      page,
      candidate.job.title,
      response?.status() === 403,
    );
    if (
      !response?.ok() &&
      !(pageExposesVacancy && (recoveredNavigation || response?.status() === 403))
    )
      throw new Error(`Job page returned ${response?.status() ?? "no response"}`);
    const captured = (await page.evaluate(`(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const plain = (value) => {
        const element = document.createElement("div");
        element.innerHTML = String(value || "");
        return clean(element.textContent);
      };
      const nodes = [];
      const collect = (value) => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) {
          value.forEach(collect);
          return;
        }
        nodes.push(value);
        if (value["@graph"]) collect(value["@graph"]);
      };
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        try { collect(JSON.parse(script.textContent || "null")); } catch {}
      }
      const posting = nodes.find((value) => {
        const type = value["@type"];
        return Array.isArray(type) ? type.includes("JobPosting") : type === "JobPosting";
      });
      const organization = posting?.hiringOrganization;
      const addressParts = [];
      const appendAddress = (value) => {
        const address = value?.address;
        for (const part of [address?.addressLocality, address?.addressRegion, address?.addressCountry]) {
          const text = clean(part);
          if (text && !addressParts.includes(text)) addressParts.push(text);
        }
      };
      const locations = posting?.jobLocation;
      if (Array.isArray(locations)) locations.forEach(appendAddress);
      else appendAddress(locations);
      const remoteRequirement = posting?.applicantLocationRequirements;
      const bodyText = clean(document.body?.innerText).slice(0, 100000);
      const workplaceType = clean(posting?.jobLocationType).includes("TELECOMMUTE") || /\bremote(?:ly)?\b/i.test(bodyText)
        ? "Remote"
        : /\bhybrid\b/i.test(bodyText)
          ? "Hybrid"
          : "";
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      const applyLink = anchors.find((link) =>
        /^(apply|apply now|submit application|start application)$/i.test(clean(link.textContent))
      );
      const applyLinks = anchors
        .map((link) => ({ text: clean(link.textContent), url: link.href }))
        .filter((link) => /apply|application|submit|candidate/i.test(link.text))
        .slice(0, 30);
      const links = anchors
        .map((link) => ({ text: clean(link.textContent), url: link.href }))
        .filter((link) => link.text && /^https?:/i.test(link.url))
        .slice(0, 400);
      const structuredTitle = clean(posting?.title);
      const structuredCompany = clean(organization?.name);
      const structuredDescription = plain(posting?.description);
      const metaDescription = document.querySelector('meta[name="description"]')?.content ||
        document.querySelector('meta[property="og:description"]')?.content || "";
      return {
        pageUrl: location.href,
        pageTitle: clean(document.title),
        metaDescription: clean(metaDescription),
        h1: clean(document.querySelector("h1")?.textContent),
        headings: Array.from(document.querySelectorAll("h1, h2, h3"))
          .map((heading) => clean(heading.textContent)).filter(Boolean).slice(0, 80),
        title: structuredTitle || clean(document.querySelector("h1")?.textContent),
        company: structuredCompany,
        location: addressParts.join(", ") || clean(remoteRequirement?.name),
        workplaceType,
        employmentType: clean(posting?.employmentType),
        description: structuredDescription,
        bodyText,
        applyUrl: applyLink?.href || "",
        applyLinks,
        links,
        structured: {
          hasJobPosting: Boolean(posting),
          title: structuredTitle,
          company: structuredCompany,
          location: addressParts.join(", ") || clean(remoteRequirement?.name),
          workplaceType,
          employmentType: clean(posting?.employmentType),
          description: structuredDescription,
          datePosted: clean(posting?.datePosted),
          validThrough: clean(posting?.validThrough),
          applyUrl: applyLink?.href || ""
        }
      };
    })()`)) as VacancyPageSnapshot & {
      title: string;
      company: string;
      location: string;
      workplaceType: string;
      employmentType: string;
      description: string;
      applyUrl: string;
    };
    if (
      /job (?:is )?no longer available|position (?:has been )?filled|applications? (?:are|is) closed|vacancy expired|this job has expired|\barchived\b/i.test(
        `${captured.title} ${captured.bodyText}`,
      )
    )
      throw new Error("Job page says the vacancy is closed or expired");
    if (captured.bodyText.length < 120)
      throw new Error("Job page did not expose enough vacancy content");
    const snapshot = repairVacancySnapshot({
      pageUrl: captured.pageUrl,
      pageTitle: captured.pageTitle,
      metaDescription: captured.metaDescription,
      h1: captured.h1,
      headings: captured.headings,
      bodyText: captured.bodyText,
      applyLinks: captured.applyLinks,
      links: captured.links,
      structured: captured.structured,
    });
    const interpretation = preferVisibleActiveVacancy(
      snapshot,
      candidate,
      repairVacancyInterpretation(
      structuredVacancyIsComplete(snapshot)
        ? interpretationFromStructuredData(snapshot)
        : await interpretVacancySnapshot(codex, cwd, snapshot, {
            title: candidate.job.title,
            company: candidate.company,
            location: candidate.job.location || "",
            applyUrl: candidate.job.applyUrl,
          }),
      ),
    );
    const expandable =
      interpretation.pageType === "job_list" ||
      interpretation.pageType === "company_page" ||
      candidate.job.sourceKind === "job_list" ||
      candidate.job.sourceKind === "career_page";
    if (expandable) {
      let interpretedLeads: ListingVacancyLead[] = [];
      try {
        interpretedLeads = await extractVacancyLeadsFromListing(
          codex,
          cwd,
          snapshot,
          {
            location: discoveryWorkIntent(workspace).willingWorkLocations.join(" | "),
            workplace: discoveryWorkIntent(workspace).workplaceModes.join(", "),
            employmentTypes: workspace.profile.employmentTypes,
            skills: workspace.profile.skills,
            summary: workspace.profile.summary,
          },
          Math.min(10, Math.max(limit * 2, limit)),
        );
      } catch {
        // The frozen page still contains deterministic vacancy links. A model
        // extraction defect must not discard the entire source.
      }
      const leads = mergeListingLeads(
        interpretedLeads,
        deterministicListingVacancyLeads(
          snapshot,
          candidate.company,
          Math.min(10, Math.max(limit * 2, limit)),
        ),
      );
      const resolved = (
        await mapParallelOrdered(
          leads.slice(0, Math.min(10, Math.max(4, limit * 4))),
          Math.min(3, vacancyValidationConcurrency()),
          async (lead) => {
        const child = candidateFromListingLead(candidate, lead, snapshot.pageUrl);
        if (
          normalizeOpportunityUrl(child.job.jobUrl) ===
          normalizeOpportunityUrl(snapshot.pageUrl)
        ) {
          // A detailed card on a generic list is useful discovery evidence but
          // is not yet an independently verifiable vacancy. Follow a distinct
          // application link when one exists; otherwise keep the parent as a
          // source_page result and do not let the card enter matching.
          if (
            normalizeOpportunityUrl(child.job.applyUrl) ===
            normalizeOpportunityUrl(snapshot.pageUrl)
          )
            return [];
          const applicationChild: LiveCandidate = {
            ...child,
            job: {
              ...child.job,
              jobUrl: child.job.applyUrl,
              sourceKind: "vacancy",
            },
          };
          if (depth >= 2) return [];
          try {
            return await resolveDiscoveredJobs(
              browser,
              applicationChild,
              codex,
              cwd,
              workspace,
              1,
              depth + 1,
            );
          } catch {
            return [];
          }
        }
            if (depth >= 2) return [];
        try {
              return await resolveDiscoveredJobs(
            browser,
            child,
            codex,
            cwd,
            workspace,
                1,
            depth + 1,
          );
        } catch {
          // A list page commonly contains stale or blocked links. Other concrete
          // vacancies from the same source remain independently usable.
              return [];
            }
          },
        )
      ).flat().slice(0, limit);
      if (resolved.length) return resolved;
      throw new Error(
        `Vacancy list contained no independently validated current positions`,
      );
    }
    const interpretationGate = validateVacancyInterpretation(snapshot, interpretation);
    if (!interpretationGate.passed)
      throw new Error(
        `Vacancy interpretation failed: ${interpretationGate.failures.join("; ")}`,
      );
    const discoveredApply = preferredApplicationUrl(
      snapshot,
      interpretation,
      candidate,
      captured.applyUrl,
    );
    const descriptionPlain = normalizeExtractedText(interpretation.description);
    const workplaceType = repairMojibake(
      interpretation.workplaceType || candidate.job.workplaceType || "",
    );
    const isRemote = Boolean(
      candidate.job.isRemote || interpretation.workplaceType === "Remote",
    );
    const location = reconcileRemoteLocation({
      location: repairMojibake(
        interpretation.location || candidate.job.location || "",
      ),
      workplaceType,
      isRemote,
      descriptionPlain,
    });
    await assertPublicHttpUrl(new URL(discoveredApply));
    if (
      normalizeOpportunityUrl(discoveredApply) !==
      normalizeOpportunityUrl(captured.pageUrl)
    )
      await verifyApplicationDestination(
        browser,
        discoveredApply,
        interpretation.title,
      );
    return [{
      ...candidate,
      company: repairMojibake(interpretation.company),
      job: {
        ...candidate.job,
        title: repairMojibake(interpretation.title),
        location,
        workplaceType,
        isRemote,
        employmentType:
          repairMojibake(interpretation.employmentType || candidate.job.employmentType || ""),
        jobUrl: captured.pageUrl,
        applyUrl: discoveredApply,
        descriptionPlain,
        compensation:
          normalizeCompensationText(interpretation.compensation) ||
          normalizeCompensationText(candidate.job.compensation || "") ||
          extractCompensation(interpretation.description),
        sourceKind: "vacancy",
      },
    }];
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function pageExposesCandidateVacancy(
  page: Page,
  expectedTitle: string,
  requireApplyControl: boolean,
) {
  const visible = (await page
    .evaluate(`(() => ({
      title: String(document.querySelector("h1, h2")?.textContent || document.title || "").replace(/\\s+/g, " ").trim(),
      body: String(document.body?.innerText || "").replace(/\\s+/g, " ").trim(),
      hasApply: Array.from(document.querySelectorAll("a,button")).some((node) =>
        /^(?:apply|apply now|apply for (?:this|the) job|start application)$/i.test(
          String(node.textContent || "").replace(/\\s+/g, " ").trim()
        )
      )
    }))()` as string)
    .catch(() => undefined)) as
    | { title: string; body: string; hasApply: boolean }
    | undefined;
  if (!visible || visible.body.length < 300) return false;
  if (
    /additional verification required|cloudflare|captcha|access denied|page not found|job not found|doesn.?t exist|no longer available/i.test(
      visible.body,
    )
  )
    return false;
  const expectedTokens = normalizedTitleTokens(expectedTitle);
  const visibleTokens = new Set(
    normalizedTitleTokens(`${visible.title} ${visible.body.slice(0, 1000)}`),
  );
  const overlap = expectedTokens.filter((token) => visibleTokens.has(token)).length;
  const titleMatches =
    expectedTokens.length > 0 &&
    overlap / expectedTokens.length >= 0.65;
  return titleMatches && (!requireApplyControl || visible.hasApply);
}

function normalizedTitleTokens(value: string) {
  return [
    ...new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9+#]+/)
        .filter((token) => token.length >= 3),
    ),
  ];
}

export function preferVisibleActiveVacancy(
  snapshot: VacancyPageSnapshot,
  candidate: LiveCandidate,
  interpretation: VacancyInterpretation,
): VacancyInterpretation {
  const title = snapshot.structured.title || snapshot.h1;
  const expectedTokens = normalizedTitleTokens(candidate.job.title);
  const visibleTokens = new Set(normalizedTitleTokens(title));
  const overlap = expectedTokens.filter((token) => visibleTokens.has(token)).length;
  const titleMatches =
    expectedTokens.length > 0 &&
    overlap / expectedTokens.length >= 0.65;
  const explicitClosure =
    /job (?:is )?no longer available|position (?:has been )?filled|applications? (?:are|is) closed|vacancy expired|this job has expired|\barchived\b|page (?:you are looking for )?doesn.?t exist|job not found|page not found/i.test(
      `${snapshot.pageTitle} ${snapshot.h1} ${snapshot.bodyText}`,
    );
  const visibleApplyUrl =
    snapshot.structured.applyUrl ||
    snapshot.applyLinks.find((link) =>
      /apply|application|submit/i.test(link.text),
    )?.url;
  const applyUrl =
    visibleApplyUrl || interpretation.applyUrl || candidate.job.applyUrl;
  const active =
    titleMatches &&
    snapshot.bodyText.length >= 300 &&
    !explicitClosure &&
    Boolean(visibleApplyUrl);
  if (!active) return interpretation;
  if (
    interpretation.pageType === "vacancy" &&
    interpretation.openStatus !== "closed"
  )
    return { ...interpretation, validThrough: "" };
  return {
    ...interpretation,
    pageType: "vacancy",
    openStatus: "open",
    title: title || candidate.job.title,
    company:
      snapshot.structured.company ||
      interpretation.company ||
      candidate.company,
    description:
      snapshot.structured.description ||
      interpretation.description ||
      snapshot.bodyText,
    applyUrl,
    validThrough: "",
    confidence: Math.max(interpretation.confidence, 70),
    ambiguities: [
      ...interpretation.ambiguities,
      "A stale or uncertain status signal was overridden because the current page exposes the concrete vacancy and an active application route.",
    ],
  };
}

export function greenhouseJobApiUrl(value: string) {
  try {
    const url = new URL(value);
    if (!/^(?:job-boards|boards)\.greenhouse\.io$/i.test(url.hostname)) return "";
    const match = url.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/i);
    if (!match) return "";
    return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(match[1])}/jobs/${encodeURIComponent(match[2])}`;
  } catch {
    return "";
  }
}

export async function resolveGreenhouseCanonicalJobUrl(value: string) {
  const apiUrl = greenhouseJobApiUrl(value);
  if (!apiUrl) return "";
  await assertPublicHttpUrl(new URL(apiUrl));
  const response = await fetch(apiUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
  if (!response?.ok) return "";
  const payload = (await response.json().catch(() => undefined)) as
    | { absolute_url?: unknown }
    | undefined;
  return typeof payload?.absolute_url === "string" ? payload.absolute_url : "";
}

export function preferredApplicationUrl(
  snapshot: VacancyPageSnapshot,
  interpretation: VacancyInterpretation,
  candidate: LiveCandidate,
  capturedApplyUrl: string,
) {
  const sourceHost = new URL(snapshot.pageUrl).hostname.replace(/^www\./, "");
  const externalExactApply = snapshot.applyLinks.find((link) => {
    try {
      return (
        /^(apply|apply now|apply for job|apply for this job|start application)$/i.test(
          link.text.trim(),
        ) &&
        new URL(link.url).hostname.replace(/^www\./, "") !== sourceHost
      );
    } catch {
      return false;
    }
  })?.url;
  const suppliedSpecificApply =
    normalizeOpportunityUrl(candidate.job.applyUrl) !==
    normalizeOpportunityUrl(candidate.job.jobUrl)
      ? candidate.job.applyUrl
      : "";
  return (
    suppliedSpecificApply ||
    externalExactApply ||
    interpretation.applyUrl ||
    capturedApplyUrl ||
    snapshot.pageUrl
  );
}

export async function verifyApplicationDestination(
  browser: Browser,
  applyUrl: string,
  expectedTitle: string,
) {
  const page = await browser.newPage({ serviceWorkers: "block" });
  try {
    await guardPublicPage(page);
    let response;
    try {
      response = await page.goto(applyUrl, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (/ERR_NAME_NOT_RESOLVED/i.test(reason)) {
        try {
          response = await page.goto(applyUrl, {
            waitUntil: "domcontentloaded",
            timeout: 20_000,
          });
        } catch (retryError) {
          const retryReason =
            retryError instanceof Error ? retryError.message : String(retryError);
          if (/ERR_NAME_NOT_RESOLVED/i.test(retryReason))
            throw new Error("Application link does not resolve after retry");
          throw retryError;
        }
      } else {
        throw error;
      }
    }
    const status = response?.status();
    if (status === 401 || status === 403)
      throw new Error(`Application page access is restricted (${status})`);
    if (status === 404 || status === 410)
      throw new Error(`Application link returned ${status}`);
    if (status && status >= 500)
      throw new Error(`Application page returned temporary server error ${status}`);
    await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
    const destination = await page.evaluate(`(() => ({
      title: String(document.title || "").trim(),
      body: String(document.body?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 12000),
      url: location.href
    }))()` as string) as { title: string; body: string; url: string };
    const corpus = `${destination.title} ${destination.body}`;
    if (
      /job not found|job doesn.?t exist|job does not exist|we couldn.?t find this job|page not found|position .*no longer advertised|no longer accepting applications/i.test(
        corpus,
      )
    )
      throw new Error("Application destination confirms the vacancy is closed or unavailable");
    if (
      /cloudflare|performing security verification|additional verification required|captcha|access denied|forbidden|robot check/i.test(
        corpus,
      )
    )
      throw new Error("Application page is blocked by bot or security verification");
    if (!destination.body && destination.url === "about:blank")
      throw new Error("Application page opened as a blank response");
    if (
      destination.body.length < 40 &&
      expectedTitle &&
      !corpus.toLowerCase().includes(expectedTitle.toLowerCase())
    )
      throw new Error("Application page did not expose enough content to verify the vacancy");
  } finally {
    await page.close();
  }
}

export function candidateFromListingLead(
  parent: LiveCandidate,
  lead: ListingVacancyLead,
  pageUrl: string,
): LiveCandidate {
  const jobUrl = lead.jobUrl || pageUrl;
  const applyUrl = lead.applyUrl || jobUrl;
  const identity = `${normalizeOpportunityUrl(jobUrl)}::${lead.title.toLowerCase()}`;
  return {
    company: repairMojibake(lead.company.trim()) || parent.company,
    preliminaryFit: parent.preliminaryFit,
    job: {
      id: createHash("sha256").update(identity).digest("hex").slice(0, 20),
      title: repairMojibake(lead.title.trim()),
      location: repairMojibake(lead.location.trim()),
      workplaceType: repairMojibake(lead.workplaceType.trim()),
      employmentType: repairMojibake(lead.employmentType.trim()),
      isListed: true,
      isRemote: /remote|anywhere|worldwide|global/i.test(
        `${lead.location} ${lead.workplaceType}`,
      ),
      jobUrl,
      applyUrl,
      descriptionPlain: normalizeExtractedText(lead.description.trim()),
      compensation: normalizeCompensationText(lead.compensation.trim()),
      publishedAt: lead.publishedAt,
      sourceKind: "vacancy",
      discoveryQuery: parent.job.discoveryQuery,
      discoveryWave: parent.job.discoveryWave,
      sourceClass: parent.job.sourceClass,
    },
  };
}

export function deterministicListingVacancyLeads(
  snapshot: VacancyPageSnapshot,
  company: string,
  limit = 10,
): ListingVacancyLead[] {
  const leads: ListingVacancyLead[] = [];
  const seen = new Set<string>();
  for (const link of snapshot.links) {
    const title = listingLinkTitle(link.text);
    if (!title || !isConcreteListingVacancyUrl(snapshot.pageUrl, link.url)) continue;
    const key = normalizeOpportunityUrl(link.url);
    if (seen.has(key)) continue;
    seen.add(key);
    leads.push({
      title,
      company,
      location: "",
      workplaceType: "",
      employmentType: "",
      description: "",
      compensation: "",
      jobUrl: link.url,
      applyUrl: link.url,
      openStatus: "unknown",
      publishedAt: "",
      validThrough: "",
      evidence: [{ field: "title", sourceText: link.text }],
    });
    if (leads.length >= Math.max(1, limit)) break;
  }
  return leads;
}

export function mergeListingLeads(...groups: ListingVacancyLead[][]) {
  const merged = new Map<string, ListingVacancyLead>();
  for (const lead of groups.flat()) {
    const key = `${normalizeOpportunityUrl(lead.jobUrl)}::${lead.title.toLowerCase()}`;
    if (!merged.has(key)) merged.set(key, lead);
  }
  return [...merged.values()];
}

export function listingLinkTitle(value: string) {
  const title = repairMojibake(value).replace(/\s+/g, " ").trim();
  if (title.length < 4 || title.length > 180) return "";
  if (
    /^(apply|apply now|apply for this job|back to jobs|careers?|current openings|job|jobs|learn more|open positions|view job)$/i.test(
      title,
    )
  )
    return "";
  return title;
}

export function isConcreteListingVacancyUrl(pageUrl: string, value: string) {
  try {
    if (normalizeOpportunityUrl(pageUrl) === normalizeOpportunityUrl(value)) return false;
    const url = new URL(value);
    const path = decodeURIComponent(url.pathname).replace(/\/+$/, "");
    if (/job-boards\.greenhouse\.io$/i.test(url.hostname))
      return /\/jobs\/\d+$/i.test(path);
    if (/jobs\.lever\.co$/i.test(url.hostname))
      return /^\/[^/]+\/[0-9a-f-]{20,}$/i.test(path);
    if (/jobs\.ashbyhq\.com$/i.test(url.hostname))
      return /^\/[^/]+\/[0-9a-f-]{20,}$/i.test(path);
    if (/web3\.career$/i.test(url.hostname)) return /\/\d+$/i.test(path);
    if (/cryptocurrencyjobs\.co$/i.test(url.hostname))
      return /^\/(engineering|defi|ethereum|solana|security|web3)\/[^/]+$/i.test(path);
    return false;
  } catch {
    return false;
  }
}

export function repairVacancyInterpretation(
  interpretation: VacancyInterpretation,
): VacancyInterpretation {
  return {
    ...interpretation,
    title: repairMojibake(interpretation.title),
    company: repairMojibake(interpretation.company),
    location: repairMojibake(interpretation.location),
    workplaceType: repairMojibake(interpretation.workplaceType),
    employmentType: repairMojibake(interpretation.employmentType),
    description: repairMojibake(interpretation.description),
    compensation: repairMojibake(interpretation.compensation),
    ambiguities: interpretation.ambiguities.map(repairMojibake),
    evidence: interpretation.evidence.map((item) => ({
      field: repairMojibake(item.field),
      sourceText: repairMojibake(item.sourceText),
    })),
  };
}

export function repairVacancySnapshot(snapshot: VacancyPageSnapshot): VacancyPageSnapshot {
  return {
    ...snapshot,
    pageTitle: repairMojibake(snapshot.pageTitle),
    metaDescription: repairMojibake(snapshot.metaDescription),
    h1: repairMojibake(snapshot.h1),
    headings: snapshot.headings.map(repairMojibake),
    bodyText: repairMojibake(snapshot.bodyText),
    applyLinks: snapshot.applyLinks.map((item) => ({
      ...item,
      text: repairMojibake(item.text),
    })),
    links: snapshot.links.map((item) => ({
      ...item,
      text: repairMojibake(item.text),
    })),
    structured: {
      ...snapshot.structured,
      title: repairMojibake(snapshot.structured.title),
      company: repairMojibake(snapshot.structured.company),
      location: repairMojibake(snapshot.structured.location),
      workplaceType: repairMojibake(snapshot.structured.workplaceType),
      employmentType: repairMojibake(snapshot.structured.employmentType),
      description: repairMojibake(snapshot.structured.description),
    },
  };
}

export async function guardPublicPage(page: Page) {
  const checkedHosts = new Map<string, boolean>();
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (["image", "media", "font"].includes(request.resourceType())) {
      await route.abort();
      return;
    }
    try {
      const url = new URL(request.url());
      if (!["http:", "https:", "data:", "blob:"].includes(url.protocol)) {
        await route.abort();
        return;
      }
      if (["http:", "https:"].includes(url.protocol)) {
        if (!checkedHosts.has(url.hostname)) {
          await assertPublicHttpUrl(url);
          checkedHosts.set(url.hostname, true);
        }
      }
      await route.continue();
    } catch {
      await route.abort();
    }
  });
}
