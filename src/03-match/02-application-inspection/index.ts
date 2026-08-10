import { createHash } from "node:crypto";
import { type Browser, type Locator, type Page } from "playwright";
import type { ApplicationDraft, FormField, JobOpportunity, JobResearchFailure, JobSearchWorkspace } from "../../contracts/job-search.js";
import type { CodexExecClient } from "../../codex-runtime/client.js";
import { assertPublicHttpUrl } from "../../infrastructure/public-http.js";
import { compatibleCandidateValue } from "../../search-match-shared/candidate-facts.js";
import { repairMojibake } from "../../infrastructure/text-encoding.js";
import { guardPublicPage } from "../../02-search/v1/03-vacancy-validation/index.js";
import type { BrowserPool } from "../../search-match-shared/browser-pool.js";
import {
  mapParallelOrdered,
  vacancyValidationConcurrency,
} from "../../search-match-shared/parallel.js";
import {
  adapterForUrl,
  candidateFromOpportunity,
  cvName,
  evidenceBackedCoverLetter,
  extractCompensation,
  failureFromOpportunity,
  sourceProfileUrl,
} from "../../search-match-shared/opportunity.js";
import { progressItemFromOpportunity } from "../../search-match-shared/progress.js";
import type {
  ApplicationSchemaAudit,
  LiveCandidate,
  ObservedApplicationField,
  OpportunityProgressReporter,
} from "../../search-match-shared/types.js";
import {
  buildInput as buildApplicationNavigationInput,
  command as APPLICATION_NAVIGATION_COMMAND,
  outputSchema as applicationPageActionSchema,
  rolePrompt as APPLICATION_NAVIGATION_INSTRUCTIONS,
  type ApplicationNavigationDecision,
} from "./llm-calls/01-application-navigation/index.js";
import {
  buildInput as buildApplicationFieldMappingInput,
  command as APPLICATION_FIELD_MAPPING_COMMAND,
  outputSchema as applicationFieldInterpretationSchema,
  rolePrompt as APPLICATION_FIELD_MAPPING_INSTRUCTIONS,
  type ApplicationFieldMappingOutput,
} from "./llm-calls/02-application-field-mapping/index.js";
import {
  buildInput as buildApplicationSchemaVerificationInput,
  command as APPLICATION_SCHEMA_VERIFICATION_COMMAND,
  outputSchema as applicationSchemaAuditSchema,
  rolePrompt as APPLICATION_SCHEMA_VERIFICATION_INSTRUCTIONS,
  type ApplicationSchemaVerificationOutput,
} from "./llm-calls/03-application-schema-verification/index.js";

/**
 * Cheap, deterministic-first application reachability check. This deliberately
 * runs before evidence matching: a vacancy without a reachable employer form
 * should not consume the more expensive matching and drafting stages.
 */
export async function precheckOpportunityApplications(input: {
  codex?: CodexExecClient;
  cwd: string;
  browsers: BrowserPool;
  workspace: JobSearchWorkspace;
  opportunities: JobOpportunity[];
  onProgress?: OpportunityProgressReporter;
}) {
  const { codex, cwd, browsers, workspace, opportunities, onProgress } = input;
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
          phase: "application",
          state: "running",
        });
        try {
          const applicationUrl = await findReachableApplicationForm(
            browser,
            opportunity.applyUrl,
            codex,
            cwd,
          );
          const viable = { ...opportunity, applyUrl: applicationUrl };
          await onProgress?.({
            item: progressItemFromOpportunity(viable),
            phase: "application",
            state: "passed",
          });
          return { opportunity: viable };
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await onProgress?.({
            item: progressItemFromOpportunity(opportunity),
            phase: "application",
            state: "failed",
            reason,
          });
          return {
            failure: failureFromOpportunity(opportunity, "form", reason),
          };
        }
      },
    );
    return {
      opportunities: results
        .map((item) => item.opportunity)
        .filter((item): item is JobOpportunity => Boolean(item)),
      failures: results
        .map((item) => item.failure)
        .filter((item): item is JobResearchFailure => Boolean(item)),
    };
  } finally {
    await browsers.close(browser);
  }
}

async function findReachableApplicationForm(
  browser: Browser,
  applyUrl: string,
  codex?: CodexExecClient,
  cwd = process.cwd(),
) {
  const initialPage = await browser.newPage({ serviceWorkers: "block" });
  let page = initialPage;
  const openedPages = new Set<Page>([initialPage]);
  try {
    await assertPublicHttpUrl(new URL(applyUrl));
    await guardPublicPage(page);
    try {
      await page.goto(applyUrl, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
    } catch (error) {
      if (!/Download is starting/i.test(String(error))) throw error;
    }
    await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
    await waitForRenderedApplicationControls(page, 4_000);
    if (!(await hasLikelyApplicationForm(page))) {
      const opened = await openApplicationControl(page);
      if (opened) {
        page = opened;
        openedPages.add(page);
        await waitForRenderedApplicationControls(page, 5_000);
      }
    }
    if (!(await hasLikelyApplicationForm(page))) {
      const embedded = await openEmbeddedApplicationFrame(page);
      if (embedded) {
        page = embedded;
        openedPages.add(page);
        await waitForRenderedApplicationControls(page, 5_000);
      }
    }
    const observation = !(await hasLikelyApplicationForm(page)) && codex
      ? await observeApplicationPage(page)
      : undefined;
    const hasPlausibleApplicationControl = observation?.controls.some((control) => {
      const label = `${control.text} ${control.ariaLabel} ${control.title}`;
      return !isUnsafeApplicationAction(control) &&
        /\bapply\b|application|candidature|candidater|postuler|job opening/i.test(label);
    });
    if (!(await hasLikelyApplicationForm(page)) && codex && hasPlausibleApplicationControl) {
      const opened = await openApplicationControlWithAgent(page, codex, cwd);
      if (opened) {
        page = opened;
        openedPages.add(page);
        await waitForRenderedApplicationControls(page, 5_000);
      }
    }
    if (!(await hasLikelyApplicationForm(page)))
      throw new Error(
        "No reachable employer application form was found; the page is a listing, paywall, sign-in flow, or dead application path",
      );
    await assertPublicHttpUrl(new URL(page.url()));
    return page.url();
  } finally {
    await Promise.all(
      [...openedPages].map((openedPage) =>
        openedPage.close().catch(() => undefined),
      ),
    );
  }
}

export async function inspectOpportunityApplications(input: {
  codex?: CodexExecClient;
  cwd: string;
  browsers: BrowserPool;
  workspace: JobSearchWorkspace;
  opportunities: JobOpportunity[];
  onProgress?: OpportunityProgressReporter;
}) {
  const { codex, cwd, browsers, workspace, opportunities, onProgress } = input;
  const executionGeneration = browsers.currentGeneration(workspace.candidateId);
    const browser = await browsers.launch.bind(browsers)(
      workspace.candidateId,
      executionGeneration,
    );
    try {
      const results = await Promise.all(
        opportunities.map(async (opportunity) => {
          await onProgress?.({
            item: progressItemFromOpportunity(opportunity),
            phase: "application",
            state: "running",
          });
          const candidate = candidateFromOpportunity(opportunity);
          try {
            const inspected = await inspectLiveApplication(
              browser,
              candidate,
              workspace,
              codex,
              cwd,
            );
            await onProgress?.({
              item: progressItemFromOpportunity(opportunity),
              phase: "application",
              state: inspected.formValidated ? "passed" : "failed",
              reason: inspected.formValidated
                ? undefined
                : "Application form could not be fully mapped",
            });
            return {
              application: applicationFromLiveForm(
                opportunity,
                inspected.fields,
                workspace,
                inspected.adapter,
                inspected.formValidated,
                inspected.schemaAudit,
              ),
              failure: inspected.formValidated
                ? undefined
                : failureFromOpportunity(
                    opportunity,
                    "form",
                    "The employer form is protected, blocked, or could not be mapped automatically",
                  ),
            };
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            await onProgress?.({
              item: progressItemFromOpportunity(opportunity),
              phase: "application",
              state: "failed",
              reason,
            });
            return {
              application: applicationFromLiveForm(
                opportunity,
                [],
                workspace,
                adapterForUrl(opportunity.applyUrl),
                false,
                {
                  observedQuestionCount: 0,
                  mappedQuestionCount: 0,
                  fingerprint: "",
                  issues: ["Employer form could not be inspected"],
                  verifiedByAgent: false,
                },
              ),
              failure: failureFromOpportunity(opportunity, "form", reason),
            };
          }
        }),
      );
      return {
        applications: results.map((item) => item.application),
        failures: results
          .map((item) => item.failure)
          .filter((item): item is JobResearchFailure => Boolean(item)),
      };
    } finally {
      await browsers.close(browser);
    }
}

export async function inspectLiveApplication(
  browser: Browser,
  candidate: LiveCandidate,
  workspace: JobSearchWorkspace,
  codex?: CodexExecClient,
  cwd = process.cwd(),
): Promise<{
  compensation: string;
  fields: FormField[];
  adapter: ApplicationDraft["adapter"];
  applicationUrl: string;
  formValidated: boolean;
  schemaAudit: ApplicationSchemaAudit;
}> {
  const initialPage = await browser.newPage({ serviceWorkers: "block" });
  let page = initialPage;
  const openedPages = new Set<Page>([initialPage]);
  try {
    await assertPublicHttpUrl(new URL(candidate.job.applyUrl));
    await guardPublicPage(page);
    try {
      await page.goto(candidate.job.applyUrl, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
    } catch (error) {
      if (!/Download is starting/i.test(String(error))) throw error;
    }
    await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
    await waitForRenderedApplicationControls(page, 4_000);
    if (!(await hasLikelyApplicationForm(page))) {
      const openedApplication = await openApplicationControl(page);
      if (openedApplication) {
        page = openedApplication;
        openedPages.add(page);
        await waitForRenderedApplicationControls(page, 5_000);
      }
      if (!(await hasLikelyApplicationForm(page))) {
        const embeddedApplication = await openEmbeddedApplicationFrame(page);
        if (embeddedApplication) {
          page = embeddedApplication;
          openedPages.add(page);
          await waitForRenderedApplicationControls(page, 5_000);
        }
      }
      if (!(await hasLikelyApplicationForm(page)) && codex) {
        const openedWithAgent = await openApplicationControlWithAgent(
          page,
          codex,
          cwd,
        );
        if (openedWithAgent) {
          page = openedWithAgent;
          openedPages.add(page);
          await waitForRenderedApplicationControls(page, 5_000);
        }
      }
    }
    const result = (await page.evaluate(`(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const scoreScope = (scope) => {
        const controls = Array.from(scope.querySelectorAll('input:not([type="hidden"]), textarea, select'))
          .filter((control) => !control.disabled && control.getAttribute('aria-hidden') !== 'true');
        const identity = clean([
          scope.getAttribute('action'), scope.id, scope.className, scope.getAttribute('data-testid'),
          scope.querySelector('h1, h2, h3, legend')?.textContent,
        ].join(' ')).toLowerCase();
        let score = Math.min(5, controls.length * 0.5);
        if (/apply|application|candidature|candidat|postuler|recruit/.test(identity)) score += 7;
        if (controls.some((control) => control.matches('input[type="file"]'))) score += 6;
        if (controls.some((control) => control.matches('input[type="email"]'))) score += 3;
        if (controls.some((control) => control.matches('input[type="tel"]'))) score += 2;
        if (controls.some((control) => control.matches('textarea'))) score += 2;
        if (/search|filter|newsletter|cookie|login|sign.?in|mobile.?menu/.test(identity)) score -= 9;
        return score;
      };
      const scopeCandidates = Array.from(new Set([
        ...document.querySelectorAll('form'),
        ...document.querySelectorAll('[data-testid*="application" i], [class*="application-form" i], [id*="application-form" i], .ashby-application-form-container'),
      ]));
      const selectedScope = scopeCandidates
        .map((scope) => ({ scope, score: scoreScope(scope) }))
        .sort((left, right) => right.score - left.score)[0];
      const applicationScope = selectedScope?.score >= 6 ? selectedScope.scope : null;
      const labelFor = (control, root) => {
        const explicit = control.id
          ? document.querySelector('label[for="' + CSS.escape(control.id) + '"]')
          : null;
        const labelledBy = (control.getAttribute('aria-labelledby') || '')
          .split(/\\s+/)
          .map((id) => document.getElementById(id)?.textContent || '')
          .join(' ');
        return clean(
          root?.querySelector('.ashby-application-form-question-title')?.textContent ||
          explicit?.textContent ||
          control.closest('label')?.textContent ||
          control.closest('fieldset')?.querySelector('legend')?.textContent ||
          labelledBy ||
          control.getAttribute('aria-label') ||
          root?.querySelector('label, .label, [class*="label"]')?.textContent ||
          control.getAttribute('placeholder') ||
          control.getAttribute('name') ||
          control.id
        );
      };
      const controls = applicationScope
        ? Array.from(applicationScope.querySelectorAll('input, textarea, select'))
        : [];
      const usableControls = controls
        .filter((control) => {
          const type = (control.getAttribute('type') || '').toLowerCase();
          return !['hidden', 'submit', 'button', 'reset', 'image'].includes(type) &&
            !control.disabled && control.getAttribute('aria-hidden') !== 'true' &&
            control.getClientRects().length > 0;
        });
      const seen = new Set();
      const entries = usableControls.map((control) => {
        const root = control.closest('[data-field-path], fieldset, .form-group, .field, [class*="question"], [class*="field"]') || control.parentElement;
        const name = control.getAttribute('name') || control.id || '';
        const label = labelFor(control, root);
        const noiseKey = clean(name + ' ' + label).toLowerCase();
        if (/mobile.?menu|salarymodal|recruiter.?access|alertmodal|coach.?visibility|collapse_|cookie|traceur|newsletter/.test(noiseKey)) return null;
        const radioKey = control.getAttribute('type') === 'radio' ? name : '';
        if (radioKey && seen.has('radio:' + radioKey)) return null;
        if (radioKey) seen.add('radio:' + radioKey);
        const fieldKey = [name, label, control.getAttribute('type') || control.tagName].join('|').toLowerCase();
        if (!radioKey && seen.has(fieldKey)) return null;
        if (!radioKey) seen.add(fieldKey);
        const dataRoot = control.closest('[data-field-path]');
        const scope = radioKey ? document.querySelectorAll('input[type="radio"][name="' + CSS.escape(radioKey) + '"]') : [];
        const radioLabels = Array.from(scope).map((input) => labelFor(input, input.parentElement)).filter(Boolean);
        const options = control.tagName === 'SELECT'
          ? Array.from(control.options).map((option) => clean(option.textContent || option.value)).filter(Boolean)
          : radioLabels;
        return {
          label,
          externalName: dataRoot?.getAttribute('data-field-path') || name || label,
          tag: control.tagName.toLowerCase(),
          inputType: control.getAttribute('type') || 'text',
          placeholder: control.getAttribute('placeholder') || '',
          required: Boolean(control.required || control.getAttribute('aria-required') === 'true' || /required|\\*/i.test(labelFor(control, root))),
          options: Array.from(new Set(options)),
          hasCombobox: control.getAttribute('role') === 'combobox' || Boolean(root?.querySelector('[role="combobox"]')),
          allowsManualEntry: Boolean(Array.from(root?.querySelectorAll('button') || []).some((button) => /enter manually/i.test(clean(button.textContent)))),
        };
      }).filter(Boolean);
      return { text: (document.body?.innerText || "").slice(0, 80000), entries };
    })()`)) as {
      text: string;
      entries: Array<{
        label: string;
        externalName: string;
        tag: string;
        inputType: string;
        placeholder: string;
        required: boolean;
        options: string[];
        hasCombobox: boolean;
        allowsManualEntry: boolean;
      }>;
    };
    const logicalResult = await extractLogicalApplicationForm(page);
    if (logicalResult.entries.length > 0) {
      result.entries = logicalResult.entries;
      result.text = logicalResult.text;
    } else if (result.entries.length === 0) {
      result.entries = await extractShadowPiercingFormControls(page);
    }
    for (const entry of result.entries) {
      if (!entry.hasCombobox || entry.options.length > 0) continue;
      const dataRoot = page.locator(
        `[data-field-path="${cssEscape(entry.externalName)}"]`,
      );
      const named = page.locator(
        applicationControlSelector(entry.externalName),
      );
      const root = (await dataRoot.count()) > 0 ? dataRoot.first() : named.first();
      const combobox =
        (await root.getAttribute("role")) === "combobox"
          ? root
          : root.getByRole("combobox").first();
      if ((await combobox.count()) === 0) continue;
      await combobox.click().catch(() => undefined);
      await page.waitForTimeout(150);
      entry.options = await page
        .getByRole("option")
        .allTextContents()
        .then((items) => [...new Set(items.map((item) => item.trim()).filter(Boolean))])
        .catch(() => []);
      await page.keyboard.press("Escape").catch(() => undefined);
    }
    let fields = result.entries
      .filter((entry) => entry.label && entry.externalName)
      .map((entry, index) => mapLiveField(entry, index, workspace))
      .filter((field): field is FormField => Boolean(field));
    if (codex && fields.length)
      fields = await interpretApplicationFields(codex, cwd, fields, workspace);
    const deterministicIssues = auditApplicationFieldMapping(
      result.entries,
      fields,
    );
    const agentIssues =
      codex && fields.length && deterministicIssues.length === 0
        ? await auditApplicationFieldsWithAgent(
            codex,
            cwd,
            result.entries,
            fields,
          )
        : [];
    // The independent agent is useful for detecting suspicious mappings, but
    // semantic representation differences (URL as text, radio as select,
    // optional EEO aliases) must not reject a structurally complete employer
    // form. Deterministic one-to-one structural coverage remains the gate.
    const issues = [...new Set(deterministicIssues)];
    const schemaAudit: ApplicationSchemaAudit = {
      observedQuestionCount: result.entries.length,
      mappedQuestionCount: fields.length,
      fingerprint: applicationSchemaFingerprint(result.entries),
      issues,
      verifiedByAgent: Boolean(
        codex && deterministicIssues.length === 0 && agentIssues.length === 0,
      ),
    };
    const credibleEmployerForm = applicationFieldSetLooksCredible(result.entries);
    return {
      compensation:
        extractCompensation(result.text) ||
        candidate.job.compensation ||
        extractCompensation(candidate.job.descriptionPlain || ""),
      fields,
      adapter: adapterForUrl(page.url()),
      applicationUrl: page.url(),
      formValidated:
        credibleEmployerForm && fields.length > 0 && issues.length === 0,
      schemaAudit,
    };
  } finally {
    await Promise.all(
      [...openedPages].map((openedPage) =>
        openedPage.close().catch(() => undefined),
      ),
    );
  }
}

export async function hasLikelyApplicationForm(page: Page): Promise<boolean> {
  const visibleControls = await page
    .locator('input:not([type="hidden"]):visible, textarea:visible, select:visible')
    .count();
  const identityControls = await page
    .locator(
      'input[type="email"]:visible, input[type="tel"]:visible, input[type="file"]',
    )
    .count();
  const uploadControls = await page.locator('input[type="file"]').count();
  if (visibleControls >= 3 && identityControls > 0 && uploadControls > 0)
    return true;
  return (await page.evaluate(`(() => {
    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const scopes = Array.from(new Set([
      ...document.querySelectorAll('form'),
      ...document.querySelectorAll('[data-testid*="application" i], [class*="application-form" i], [id*="application-form" i], .ashby-application-form-container'),
    ]));
    return scopes.some((scope) => {
      const controls = Array.from(scope.querySelectorAll('input:not([type="hidden"]), textarea, select'))
        .filter((control) => !control.disabled && control.getAttribute('aria-hidden') !== 'true' && control.getClientRects().length > 0);
      if (controls.length < 3) return false;
      const identity = clean([
        scope.getAttribute('action'), scope.id, scope.className, scope.getAttribute('data-testid'),
        scope.querySelector('h1, h2, h3, legend')?.textContent,
      ].join(' ')).toLowerCase();
      let score = Math.min(5, controls.length * 0.5);
      if (/apply|application|candidature|candidat|postuler|recruit/.test(identity)) score += 7;
      if (controls.some((control) => control.matches('input[type="file"]'))) score += 6;
      if (controls.some((control) => control.matches('input[type="email"]'))) score += 3;
      if (controls.some((control) => control.matches('input[type="tel"]'))) score += 2;
      if (controls.some((control) => control.matches('textarea'))) score += 2;
      if (/search|filter|newsletter|cookie|login|sign.?in|mobile.?menu/.test(identity)) score -= 9;
      return score >= 6;
    });
  })()`)) as boolean;
}

export async function openApplicationControlWithAgent(
  page: Page,
  codex: CodexExecClient,
  cwd: string,
) {
  let activePage = page;
  const runtime = await codex.start();
  const model =
    process.env.ROLEGAIN_FAST_MODEL ||
    runtime.models.find((item) => item.id === "gpt-5.4-mini")?.id ||
    runtime.model;
  const thread = await codex.startThread({
    cwd,
    callId: "application.navigate",
    role: APPLICATION_NAVIGATION_COMMAND.role,
    sandbox: "read-only",
    model,
    approvalPolicy: APPLICATION_NAVIGATION_COMMAND.approvalPolicy,
    developerInstructions: APPLICATION_NAVIGATION_INSTRUCTIONS,
  });
  for (let step = 0; step < 10; step += 1) {
    if (await hasLikelyApplicationForm(activePage)) return activePage;
    const embeddedApplication = await openEmbeddedApplicationFrame(activePage);
    if (embeddedApplication) {
      activePage = embeddedApplication;
      if (await hasLikelyApplicationForm(activePage)) return activePage;
    }
    const observation = await observeApplicationPage(activePage);
    if (!observation.controls.length) return undefined;
    const result = await codex.runTurn({
      threadId: thread.id,
      cwd,
      sandbox: APPLICATION_NAVIGATION_COMMAND.sandbox,
      model,
      effort: APPLICATION_NAVIGATION_COMMAND.effort,
      timeoutMs: APPLICATION_NAVIGATION_COMMAND.timeoutMs,
      outputSchema: applicationPageActionSchema,
      prompt: buildApplicationNavigationInput({
        step,
        maximumSteps: 10,
        observation,
      }),
    });
    const parsed = JSON.parse(result.finalText) as ApplicationNavigationDecision;
    if (parsed.action === "stop") return undefined;
    if (parsed.action === "scroll") {
      await activePage.mouse.wheel(0, 900);
    } else if (parsed.action === "wait") {
      await activePage.waitForTimeout(750);
    } else {
      const control = observation.controls.find(
        (item) => item.id === parsed.controlId,
      );
      if (!control || isUnsafeApplicationAction(control)) return undefined;
      const locator = activePage.locator(
        `[data-agent-action-id="${cssEscape(parsed.controlId)}"]`,
      );
      if ((await locator.count()) !== 1) return undefined;
      activePage = await clickAndCaptureApplicationPage(activePage, locator);
    }
    await activePage
      .waitForLoadState("domcontentloaded", { timeout: 5_000 })
      .catch(() => undefined);
    await activePage.waitForTimeout(350);
  }
  return (await hasLikelyApplicationForm(activePage)) ? activePage : undefined;
}

export async function observeApplicationPage(page: Page) {
  const controls = await page
    .locator('button:visible, a:visible, [role="button"]:visible')
    .evaluateAll((nodes) =>
      nodes.slice(0, 160).map((node, index) => {
        const id = `agent-action-${index + 1}`;
        node.setAttribute("data-agent-action-id", id);
        return {
          id,
          text: (node.textContent || "").replace(/\s+/g, " ").trim(),
          ariaLabel: node.getAttribute("aria-label") || "",
          title: node.getAttribute("title") || "",
          href: node instanceof HTMLAnchorElement ? node.href : "",
          disabled:
            node.hasAttribute("disabled") ||
            node.getAttribute("aria-disabled") === "true",
        };
      }),
    );
  const context = await page.locator("body").innerText().catch(() => "");
  return {
    url: page.url(),
    title: await page.title(),
    pageText: context.replace(/\s+/g, " ").trim().slice(0, 12_000),
    controls,
  };
}

export function isUnsafeApplicationAction(control: {
  text: string;
  ariaLabel: string;
  title: string;
  disabled: boolean;
}) {
  if (control.disabled) return true;
  const label = `${control.text} ${control.ariaLabel} ${control.title}`
    .replace(/\s+/g, " ")
    .trim();
  return /submit|send application|complete application|create account|sign in|log in|accept terms|agree and submit/i.test(
    label,
  );
}

export async function interpretApplicationFields(
  codex: CodexExecClient,
  cwd: string,
  fields: FormField[],
  workspace: JobSearchWorkspace,
) {
  const runtime = await codex.start();
  const model =
    process.env.ROLEGAIN_FAST_MODEL ||
    runtime.models.find((item) => item.id === "gpt-5.4-mini")?.id ||
    runtime.model;
  const thread = await codex.startThread({
    cwd,
    callId: "application.field-map",
    role: APPLICATION_FIELD_MAPPING_COMMAND.role,
    sandbox: "read-only",
    model,
    approvalPolicy: APPLICATION_FIELD_MAPPING_COMMAND.approvalPolicy,
    developerInstructions: APPLICATION_FIELD_MAPPING_INSTRUCTIONS,
  });
  const result = await codex.runTurn({
    threadId: thread.id,
    cwd,
    sandbox: APPLICATION_FIELD_MAPPING_COMMAND.sandbox,
    model,
    effort: APPLICATION_FIELD_MAPPING_COMMAND.effort,
    timeoutMs: APPLICATION_FIELD_MAPPING_COMMAND.timeoutMs,
    outputSchema: applicationFieldInterpretationSchema,
    prompt: buildApplicationFieldMappingInput(fields),
  });
  const parsed = JSON.parse(result.finalText) as ApplicationFieldMappingOutput;
  const allowed = new Set(fields.map((field) => field.id));
  const mappings = new Map(
    parsed.fields
      .filter((field) => allowed.has(field.fieldId) && field.canonicalKey !== "other")
      .map((field) => [field.fieldId, field.canonicalKey]),
  );
  return fields.map((field) => {
    const canonicalKey = preserveStructuralCanonicalKey(
      field,
      mappings.get(field.id) || field.canonicalKey,
    );
    if (!canonicalKey || canonicalKey === field.canonicalKey || field.value.trim())
      return { ...field, canonicalKey };
    const mapped = mappedValue(canonicalKey, workspace);
    const value =
      field.type === "select" && field.options?.length
        ? compatibleCandidateValue(field, mapped.value)
        : mapped.value;
    return {
      ...field,
      canonicalKey,
      value,
      source: mapped.source,
      confidence: value ? mapped.confidence : 0,
    };
  });
}

export function preserveStructuralCanonicalKey(
  field: FormField,
  interpreted: string | undefined,
) {
  const identity = `${field.label} ${field.externalName || ""}`.toLowerCase();
  const externalName = (field.externalName || "").toLowerCase();
  const label = field.label.toLowerCase();
  if (/^phone\b/.test(field.label.toLowerCase()) && field.type === "select")
    return "phone_country_code";
  if (/state.*(?:reside|residence)|residence.*state/.test(identity)) return "state";
  if (/location\s*\(city\)|\bcity\b/.test(identity)) return "city";
  if (/which country.*work|from which country.*work|country.*work from/.test(identity))
    return "country";
  if (/start[-_ ]month|start date month/.test(identity))
    return "education_start_month";
  if (/start[-_ ]year|start date year/.test(identity))
    return "education_start_year";
  if (/end[-_ ]month|end date month/.test(identity))
    return "education_end_month";
  if (/end[-_ ]year|end date year/.test(identity))
    return "education_end_year";
  if (/notice period/.test(identity)) return "notice_period";
  if (/\brace\b/.test(externalName) || /^race\b/.test(label))
    return "eeoc_race";
  if (/ethnicity/.test(externalName) || /^(?:ethnicity|hispanic|latino)\b/.test(label))
    return "eeoc_ethnicity";
  if (field.canonicalKey && STABLE_APPLICATION_CANONICAL_KEYS.has(field.canonicalKey))
    return field.canonicalKey;
  return interpreted;
}

export const STABLE_APPLICATION_CANONICAL_KEYS = new Set([
  "name",
  "first_name",
  "last_name",
  "email",
  "phone",
  "phone_country_code",
  "cv",
  "work_region",
  "current_location",
  "city",
  "state",
  "country",
  "intended_work_location",
  "start_date",
  "notice_period",
  "work_authorization",
  "sponsorship",
  "linkedin",
  "github",
  "website",
  "cover_letter",
  "target_position",
  "job_source",
  "school",
  "degree",
  "discipline",
  "education_start_month",
  "education_start_year",
  "education_end_month",
  "education_end_year",
  "eeoc_gender",
  "eeoc_ethnicity",
  "eeoc_race",
  "eeoc_veteran_status",
  "eeoc_disability_status",
]);

export function auditApplicationFieldMapping(
  observed: ObservedApplicationField[],
  fields: FormField[],
) {
  const issues: string[] = [];
  const byExternalName = new Map<string, FormField[]>();
  for (const field of fields) {
    const key = (field.externalName || "").trim();
    if (!key) {
      issues.push(`Mapped field ${field.label} has no employer identifier`);
      continue;
    }
    byExternalName.set(key, [...(byExternalName.get(key) || []), field]);
  }
  for (const entry of observed) {
    const candidates = byExternalName.get(entry.externalName) || [];
    const exactLabel = candidates.filter(
      (field) => normalizedSchemaValue(field.label) === normalizedSchemaValue(entry.label),
    );
    const mapped = exactLabel.length === 1
      ? exactLabel[0]
      : candidates.length === 1
        ? candidates[0]
        : undefined;
    if (!mapped) {
      if (entry.required)
        issues.push(`${entry.label}: required employer question was not mapped uniquely`);
      continue;
    }
    const field = mapped;
    if (entry.required && !field.required)
      issues.push(`${entry.label}: required status was not preserved`);
    const expectedOptions = new Set(entry.options.map(normalizedSchemaValue));
    const mappedOptions = new Set((field.options || []).map(normalizedSchemaValue));
    if (
      entry.required &&
      expectedOptions.size > 0 &&
      (expectedOptions.size !== mappedOptions.size ||
        [...expectedOptions].some((option) => !mappedOptions.has(option)))
    )
      issues.push(`${entry.label}: employer choices were not preserved exactly`);
    const expectedType = observedFieldType(entry);
    const compatibleManualCover =
      entry.allowsManualEntry &&
      field.canonicalKey === "cover_letter" &&
      field.type === "textarea";
    if (entry.required && field.type !== expectedType && !compatibleManualCover)
      issues.push(
        `${entry.label}: employer control ${expectedType} was mapped as ${field.type}`,
      );
  }
  return [...new Set(issues)];
}

export function observedFieldType(entry: ObservedApplicationField): FormField["type"] {
  if (entry.inputType === "file") return "file";
  if (entry.inputType === "email") return "email";
  if (entry.inputType === "tel") return "tel";
  if (entry.tag === "textarea" || entry.inputType === "textarea") return "textarea";
  if (entry.tag === "select" || entry.options.length > 1) return "select";
  if (/date/i.test(entry.placeholder)) return "date";
  if (entry.inputType === "checkbox") return "checkbox";
  return "text";
}

export function normalizedSchemaValue(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export function applicationSchemaFingerprint(entries: ObservedApplicationField[]) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        entries.map((entry) => ({
          externalName: entry.externalName,
          label: entry.label,
          type: observedFieldType(entry),
          required: entry.required,
          options: entry.options,
          allowsManualEntry: entry.allowsManualEntry,
        })),
      ),
    )
    .digest("hex");
}

export async function auditApplicationFieldsWithAgent(
  codex: CodexExecClient,
  cwd: string,
  observed: ObservedApplicationField[],
  fields: FormField[],
) {
  try {
    const runtime = await codex.start();
    const model =
      process.env.ROLEGAIN_FAST_MODEL ||
      runtime.models.find((item) => item.id === "gpt-5.4-mini")?.id ||
      runtime.model;
    const thread = await codex.startThread({
      cwd,
      callId: "application.schema-verify",
      role: APPLICATION_SCHEMA_VERIFICATION_COMMAND.role,
      sandbox: "read-only",
      model,
      approvalPolicy: APPLICATION_SCHEMA_VERIFICATION_COMMAND.approvalPolicy,
      developerInstructions: APPLICATION_SCHEMA_VERIFICATION_INSTRUCTIONS,
    });
    const result = await codex.runTurn({
      threadId: thread.id,
      cwd,
      sandbox: APPLICATION_SCHEMA_VERIFICATION_COMMAND.sandbox,
      model,
      effort: APPLICATION_SCHEMA_VERIFICATION_COMMAND.effort,
      timeoutMs: APPLICATION_SCHEMA_VERIFICATION_COMMAND.timeoutMs,
      outputSchema: applicationSchemaAuditSchema,
      prompt: buildApplicationSchemaVerificationInput({
        observed,
        mapped: fields,
      }),
    });
    const parsed = JSON.parse(
      result.finalText,
    ) as ApplicationSchemaVerificationOutput;
    return parsed.issues.map((issue) => repairMojibake(issue.trim())).filter(Boolean);
  } catch (error) {
    return [
      `Independent application schema audit failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
}

export async function waitForRenderedApplicationControls(page: Page, timeout: number) {
  await page
    .locator(
      'input[type="email"]:visible, input[type="tel"]:visible, textarea:visible, select:visible',
    )
    .first()
    .waitFor({ state: "visible", timeout })
    .catch(() => undefined);
}

export async function extractLogicalApplicationForm(page: Page): Promise<{
  text: string;
  entries: ObservedApplicationField[];
}> {
  // tsx/esbuild can annotate nested function names with a small `__name`
  // helper. Playwright serializes the callback but not that module helper, so
  // provide the harmless identity helper inside the page realm first.
  await page.evaluate(
    "globalThis.__name = globalThis.__name || ((target) => target)",
  );
  return page.evaluate(() => {
    const clean = (value: unknown) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim();
    const isUsable = (control: Element) => {
      const input = control as HTMLInputElement;
      const type = (input.type || "").toLowerCase();
      return !["hidden", "submit", "button", "reset", "image"].includes(type) &&
        !input.disabled &&
        control.getAttribute("aria-hidden") !== "true" &&
        (type === "file" || control.getClientRects().length > 0);
    };
    const controlLabel = (control: Element, root: Element) => {
      const id = control.getAttribute("id") || "";
      const explicit = id
        ? document.querySelector(`label[for="${CSS.escape(id)}"]`)
        : null;
      const labelledBy = (control.getAttribute("aria-labelledby") || "")
        .split(/\s+/)
        .map((item) => document.getElementById(item)?.textContent || "")
        .join(" ");
      return clean(
        explicit?.textContent ||
          control.closest("label")?.textContent ||
          root.querySelector("legend")?.textContent ||
          labelledBy ||
          control.getAttribute("aria-label") ||
          control.getAttribute("placeholder") ||
          control.getAttribute("name") ||
          control.getAttribute("id"),
      );
    };
    const fieldRoot = (control: Element) =>
      control.closest(
        '[data-field-path], fieldset, .form-group, .field, [class*="question"], [class*="field"]',
      ) || control.parentElement || control;
    const labelFor = (root: Element, controls: Element[]) => {
      const concise = (value: unknown) =>
        clean(value)
          .replace(/select\s*\.{3}.*$/i, "")
          .replace(/no location found\..*$/i, "")
          .trim();
      const question = root.querySelector(
        '.ashby-application-form-question-title, legend, [data-testid*="label" i]',
      );
      if (clean(question?.textContent)) return concise(question?.textContent);
      const first = controls[0];
      const firstLabel = first ? controlLabel(first, root) : "";
      const lines = String((root as HTMLElement).innerText || root.textContent || "")
        .split(/\r?\n/)
        .map(clean)
        .filter(Boolean);
      if (
        (first as HTMLInputElement | undefined)?.type === "file" &&
        (!firstLabel || /^(?:attach|upload|choose file)/i.test(firstLabel))
      ) {
        const fileLabel = lines.find((line) =>
          /resume|curriculum|\bcv\b|cover letter|motivation letter/i.test(line),
        );
        if (fileLabel) return fileLabel;
      }
      return concise(firstLabel || lines[0] || "");
    };
    const optionLabel = (control: Element, root: Element) => {
      const id = control.getAttribute("id") || "";
      const explicit = id
        ? root.querySelector(`label[for="${CSS.escape(id)}"]`) ||
          document.querySelector(`label[for="${CSS.escape(id)}"]`)
        : null;
      return clean(
        explicit?.textContent ||
          control.closest("label")?.textContent ||
          control.getAttribute("aria-label") ||
          control.getAttribute("value") ||
          control.textContent,
      );
    };
    const logicalEntry = (
      root: Element,
      suppliedControls?: Element[],
    ): ObservedApplicationField | null => {
      const controls = (suppliedControls || [
        ...root.querySelectorAll("input, textarea, select"),
      ]).filter(isUsable);
      const choiceControls = [
        ...root.querySelectorAll(
          'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]',
        ),
      ].filter(isUsable);
      const buttons = [...root.querySelectorAll("button")].filter(
        (button) =>
          button.getClientRects().length > 0 &&
          !/attach|upload|enter manually|remove|delete|add another|submit|apply/i.test(
            clean(button.textContent),
          ),
      );
      if (controls.length === 0 && choiceControls.length === 0 && buttons.length < 2)
        return null;
      const dataPath = root.getAttribute("data-field-path") || "";
      const first = controls[0] || choiceControls[0] || buttons[0];
      const label = labelFor(root, controls.length ? controls : [first]);
      const externalName =
        dataPath ||
        first?.getAttribute("name") ||
        first?.getAttribute("id") ||
        label;
      if (!label || !externalName) return null;
      const nativeOptions = choiceControls.map((item) => optionLabel(item, root));
      const selectOptions = controls.flatMap((item) =>
        item instanceof HTMLSelectElement
          ? [...item.options]
              .map((option) => clean(option.textContent || option.value))
              .filter((option) => option && !/^select|choose/i.test(option))
          : [],
      );
      const buttonOptions = buttons.length >= 2
        ? buttons.map((button) => clean(button.textContent))
        : [];
      const options = [...new Set([...nativeOptions, ...selectOptions, ...buttonOptions])]
        .filter(Boolean);
      const file = controls.find(
        (item) => (item as HTMLInputElement).type === "file",
      );
      const textarea = controls.find((item) => item.tagName === "TEXTAREA");
      const select = controls.find((item) => item.tagName === "SELECT");
      const combobox = root.querySelector('[role="combobox"]');
      const inputType = file
        ? "file"
        : textarea
          ? "textarea"
          : select
            ? "select"
            : choiceControls.some(
                  (item) =>
                    (item as HTMLInputElement).type === "checkbox" ||
                    item.getAttribute("role") === "checkbox",
                )
              ? "checkbox"
              : choiceControls.length || buttons.length >= 2
                ? "radio"
                : first?.getAttribute("type") || "text";
      const requiredText = `${label} ${clean(root.textContent).slice(0, 500)}`;
      return {
        label,
        externalName,
        tag: textarea ? "textarea" : select ? "select" : first?.tagName.toLowerCase() || "input",
        inputType,
        placeholder: controls[0]?.getAttribute("placeholder") || "",
        required: Boolean(
          controls.some(
            (item) =>
              (item as HTMLInputElement).required ||
              item.getAttribute("aria-required") === "true",
          ) ||
            root.getAttribute("aria-required") === "true" ||
            /required/i.test(requiredText) ||
            /\*/.test(requiredText),
        ),
        options,
        hasCombobox: Boolean(combobox),
        allowsManualEntry: [...root.querySelectorAll("button")].some((button) =>
          /enter manually/i.test(clean(button.textContent)),
        ),
      };
    };
    const scopes = [...new Set([
      ...document.querySelectorAll("form"),
      ...document.querySelectorAll(
        '[data-testid*="application" i], [class*="application-form" i], [id*="application-form" i], .ashby-application-form-container',
      ),
    ])];
    const score = (scope: Element) => {
      const controls = [...scope.querySelectorAll("input, textarea, select")].filter(isUsable);
      const identity = clean(
        `${scope.getAttribute("action")} ${scope.id} ${scope.className} ${scope.querySelector("h1,h2,h3,legend")?.textContent}`,
      ).toLowerCase();
      return controls.length +
        (/apply|application|candidate|recruit/.test(identity) ? 12 : 0) +
        (controls.some((item) => (item as HTMLInputElement).type === "file") ? 8 : 0) -
        (/search|filter|newsletter|cookie|login|sign.?in/.test(identity) ? 20 : 0);
    };
    const scope = scopes.sort((left, right) => score(right) - score(left))[0];
    if (!scope) return { text: clean(document.body?.innerText).slice(0, 80000), entries: [] };
    const dataRoots = [...scope.querySelectorAll(":scope [data-field-path]")].filter(
      (root) => !root.parentElement?.closest("[data-field-path]"),
    );
    let entries: ObservedApplicationField[];
    if (dataRoots.length >= 2) {
      entries = dataRoots.map((root) => logicalEntry(root)).filter(Boolean) as ObservedApplicationField[];
    } else {
      const controls = [...scope.querySelectorAll("input, textarea, select")].filter(isUsable);
      const groups = new Map<string, Element[]>();
      controls.forEach((control, index) => {
        const type = (control as HTMLInputElement).type;
        const name = control.getAttribute("name") || "";
        const key = (type === "radio" || type === "checkbox") && name
          ? `choice:${name}`
          : `control:${index}`;
        groups.set(key, [...(groups.get(key) || []), control]);
      });
      entries = [...groups.values()]
        .map((group) => logicalEntry(fieldRoot(group[0]), group))
        .filter(Boolean) as ObservedApplicationField[];
    }
    const seen = new Set<string>();
    entries = entries.filter((entry) => {
      const noise = `${entry.externalName} ${entry.label}`.toLowerCase();
      if (/mobile.?menu|salarymodal|alertmodal|cookie|newsletter/.test(noise)) return false;
      const key = entry.externalName.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return {
      text: clean((scope as HTMLElement).innerText || document.body?.innerText).slice(0, 80000),
      entries,
    };
  });
}

export async function extractShadowPiercingFormControls(page: Page): Promise<
  Array<{
    label: string;
    externalName: string;
    tag: string;
    inputType: string;
    placeholder: string;
    required: boolean;
    options: string[];
    hasCombobox: boolean;
    allowsManualEntry: boolean;
  }>
> {
  const controls = page.locator(
    'input[type="file"], input:not([type="hidden"]):visible, textarea:visible, select:visible',
  );
  const count = Math.min(await controls.count(), 120);
  const entries: Array<{
    label: string;
    externalName: string;
    tag: string;
    inputType: string;
    placeholder: string;
    required: boolean;
    options: string[];
    hasCombobox: boolean;
    allowsManualEntry: boolean;
  }> = [];
  const seen = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const entry = await controls
      .nth(index)
      .evaluate((element) => {
        const control = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        if (["hidden", "submit", "button", "reset", "image"].includes(control.type))
          return undefined;
        const clean = (value: unknown) =>
          String(value || "")
            .replace(/\s+/g, " ")
            .trim();
        const rootNode = control.getRootNode() as Document | ShadowRoot;
        const escapedId = control.id && globalThis.CSS?.escape
          ? globalThis.CSS.escape(control.id)
          : control.id;
        const explicit = escapedId
          ? rootNode.querySelector(`label[for="${escapedId}"]`)
          : null;
        const labelledBy = (control.getAttribute("aria-labelledby") || "")
          .split(/\s+/)
          .map((id) => rootNode.getElementById?.(id)?.textContent || "")
          .join(" ");
        const fieldRoot = control.closest(
          '[data-field-path], fieldset, .form-group, .field, [class*="question"], [class*="field"]',
        );
        const labels = "labels" in control && control.labels
          ? Array.from(control.labels).map((label) => label.textContent).join(" ")
          : "";
        const label = clean(
          labels ||
            explicit?.textContent ||
            control.closest("label")?.textContent ||
            control.closest("fieldset")?.querySelector("legend")?.textContent ||
            labelledBy ||
            control.getAttribute("aria-label") ||
            fieldRoot?.querySelector("label, .label, [class*=\"label\"]")?.textContent ||
            control.getAttribute("placeholder") ||
            control.getAttribute("name") ||
            control.id,
        );
        const dataRoot = control.closest("[data-field-path]");
        const options = control instanceof HTMLSelectElement
          ? Array.from(control.options)
              .map((option) => clean(option.textContent || option.value))
              .filter(Boolean)
          : [];
        return {
          label,
          externalName:
            dataRoot?.getAttribute("data-field-path") ||
            control.getAttribute("name") ||
            control.id ||
            label,
          tag: control.tagName.toLowerCase(),
          inputType: control.getAttribute("type") || "text",
          placeholder: control.getAttribute("placeholder") || "",
          required: Boolean(
            control.required ||
              control.getAttribute("aria-required") === "true" ||
              /required|\*/i.test(label),
          ),
          options: [...new Set(options)],
          hasCombobox:
            control.getAttribute("role") === "combobox" ||
            Boolean(fieldRoot?.querySelector('[role="combobox"]')),
          allowsManualEntry: Boolean(
            fieldRoot &&
              Array.from(fieldRoot.querySelectorAll("button")).some((button) =>
                /enter manually/i.test(clean(button.textContent)),
              ),
          ),
        };
      })
      .catch(() => undefined);
    if (!entry?.label || !entry.externalName) continue;
    const noiseKey = `${entry.externalName} ${entry.label}`.toLowerCase();
    if (
      /mobile.?menu|salarymodal|recruiter.?access|alertmodal|coach.?visibility|collapse_|cookie|traceur|newsletter/.test(
        noiseKey,
      )
    )
      continue;
    const key = `${entry.externalName}|${entry.label}|${entry.inputType}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries;
}

export function applicationFieldSetLooksCredible(
  entries: ObservedApplicationField[],
) {
  const hasFile = entries.some((entry) => entry.inputType === "file");
  const identity = entries
    .map((entry) => `${entry.label} ${entry.externalName} ${entry.inputType}`)
    .join(" ")
    .toLowerCase();
  const hasCandidateIdentity =
    hasFile ||
    entries.some((entry) => entry.inputType === "email" || entry.inputType === "tel") ||
    /\b(?:full name|first name|last name|phone|resume|curriculum|cv|cover letter|linkedin|github|portfolio)\b/.test(
      identity,
    );
  const searchOnly = entries.every((entry) =>
    /search|filter|job titles?|companies|location search|keywords?/.test(
      `${entry.label} ${entry.externalName}`.toLowerCase(),
    ),
  );
  return !searchOnly && hasCandidateIdentity && (entries.length >= 2 || hasFile);
}

export const APPLICATION_OPEN_CONTROL_NAME = /^(?:apply|apply here|apply now|apply today|view and apply|i(?:'|’)?m interested|apply for (?:this|the)?\s*(?:job|role|position|opening)|apply on (?:the )?(?:company|employer) (?:site|website)|start application|open application|continue to application|visit job opening page|go to job page|view job opening|postuler|candidater|je postule|envoyer (?:ma|une) candidature|d[ée]poser (?:ma|une) candidature)$/i;

export async function openApplicationControl(page: Page): Promise<Page | undefined> {
  const name = APPLICATION_OPEN_CONTROL_NAME;
  const link = page.getByRole("link", { name }).first();
  const button = page.getByRole("button", { name }).first();
  await link
    .or(button)
    .first()
    .waitFor({ state: "visible", timeout: 5_000 })
    .catch(() => undefined);
  if ((await link.count()) > 0) {
    const href = await link.getAttribute("href");
    if (href) {
      const target = new URL(href, page.url());
      await assertPublicHttpUrl(target);
      try {
        await page.goto(target.href, {
          waitUntil: "domcontentloaded",
          timeout: 20_000,
        });
      } catch (error) {
        if (!/Download is starting/i.test(String(error))) throw error;
      }
    } else return clickAndCaptureApplicationPage(page, link);
  } else {
    if ((await button.count()) === 0) return undefined;
    page = await clickAndCaptureApplicationPage(page, button);
  }
  await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  return page;
}

async function clickAndCaptureApplicationPage(
  page: Page,
  locator: Locator,
): Promise<Page> {
  const popupPromise = page
    .waitForEvent("popup", { timeout: 2_000 })
    .catch(() => undefined);
  await locator.click({ timeout: 5_000 });
  const popup = await popupPromise;
  if (!popup) return page;
  await popup
    .waitForLoadState("domcontentloaded", { timeout: 10_000 })
    .catch(() => undefined);
  await assertPublicHttpUrl(new URL(popup.url()));
  await guardPublicPage(popup);
  return popup;
}

export async function openEmbeddedApplicationFrame(
  page: Page,
): Promise<Page | undefined> {
  const frameUrl = await page.evaluate(() => {
    const frames = [...document.querySelectorAll("iframe[src]")]
      .map((frame) => {
        const identity = `${frame.getAttribute("title") || ""} ${frame.getAttribute("name") || ""} ${frame.id} ${frame.className} ${frame.getAttribute("src") || ""}`.toLowerCase();
        let score = 0;
        if (/apply|application|candidate|recruit|greenhouse|ashby|lever|workable|smartrecruiters/.test(identity)) score += 10;
        if (/job|career|form/.test(identity)) score += 3;
        if (/youtube|vimeo|map|cookie|chat/.test(identity)) score -= 10;
        return { src: frame.getAttribute("src") || "", score };
      })
      .filter((item) => item.src && item.score > 0)
      .sort((left, right) => right.score - left.score);
    return frames[0]?.src || "";
  });
  if (!frameUrl) return undefined;
  const target = new URL(frameUrl, page.url());
  await assertPublicHttpUrl(target);
  if (target.href === page.url()) return undefined;
  try {
    await page.goto(target.href, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
  } catch (error) {
    if (!/Download is starting/i.test(String(error))) return undefined;
  }
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  return page;
}

export function mapLiveField(
  entry: ObservedApplicationField,
  index: number,
  workspace: JobSearchWorkspace,
): FormField | undefined {
  const label = entry.label.trim();
  if (!label) return undefined;
  let canonicalKey = canonicalFieldKey(label, entry.externalName);
  let type: FormField["type"] = "text";
  if (entry.inputType === "file") type = "file";
  else if (entry.inputType === "email") type = "email";
  else if (entry.inputType === "tel") type = "tel";
  else if (entry.tag === "textarea") type = "textarea";
  else if (entry.tag === "select" || entry.options.length > 1) type = "select";
  else if (/date/i.test(entry.placeholder) || /when can you start/i.test(label))
    type = "date";
  else if (entry.inputType === "checkbox") type = "checkbox";
  if (/^phone\b/i.test(label) && type === "select")
    canonicalKey = "phone_country_code";
  if (entry.allowsManualEntry && canonicalKey === "cover_letter")
    type = "textarea";
  const mapped = mappedValue(canonicalKey, workspace);
  const candidateValue =
    type === "select" && entry.options.length
      ? compatibleCandidateValue(
          {
            id: "candidate-choice",
            label,
            canonicalKey,
            type,
            value: "",
            required: entry.required,
            source: "profile",
            confidence: 0,
            options: entry.options,
          },
          mapped.value,
        )
      : mapped.value;
  const cvUpload = type === "file" && canonicalKey === "cv";
  return {
    id: `${canonicalKey}-${index + 1}`,
    canonicalKey,
    externalName: entry.externalName,
    label,
    type,
    value: cvUpload ? cvName(workspace) : type === "file" ? "" : candidateValue,
    required: entry.required,
    source: cvUpload ? "cv" : type === "file" ? "generated" : mapped.source,
    confidence:
      cvUpload ? 100 : type === "file" ? 0 : candidateValue ? mapped.confidence : 0,
    options: entry.options,
  };
}

export function applicationFromLiveForm(
  job: JobOpportunity,
  fields: FormField[],
  workspace: JobSearchWorkspace,
  adapter: ApplicationDraft["adapter"],
  formValidated: boolean,
  schemaAudit: ApplicationSchemaAudit,
): ApplicationDraft {
  const coverLetter = fields.some(
    (field) => field.canonicalKey === "cover_letter",
  )
    ? evidenceBackedCoverLetter(job, workspace)
    : "";
  for (const field of fields) {
    if (field.canonicalKey === "target_position" && !field.value) {
      field.value = compatibleCandidateValue(field, job.title) || job.title;
      field.source = "generated";
      field.confidence = 100;
      field.evidence = `Derived from the verified vacancy title: ${job.title}`;
    }
    if (field.canonicalKey === "cover_letter") {
      if (field.type !== "file") {
        field.value = coverLetter;
        field.source = "generated";
        field.confidence = 85;
      }
    }
    if (field.canonicalKey === "website" && !field.value) {
      const website = workspace.sources.find(
        (source) => source.kind === "portfolio" || source.kind === "webpage",
      )?.url;
      if (website) {
        field.value = website;
        field.source = "profile";
        field.confidence = 100;
      }
    }
    if (field.canonicalKey === "work_region" && !field.value) {
      const region = inferredWorkRegion(workspace);
      const option = field.options?.find(
        (candidate) => candidate.toLowerCase() === region.toLowerCase(),
      );
      if (option) {
        field.value = option;
        field.source = "profile";
        field.confidence = 95;
        field.evidence = `Derived from confirmed candidate location: ${workspace.profile.location}`;
      }
    }
    if (field.canonicalKey === "job_source" && !field.value) {
      field.value = sourceDescription();
      field.source = "generated";
      field.confidence = 100;
      field.evidence = `Derived from the job source URL: ${job.sourceUrl}`;
    }
  }
  const missingQuestions = fields
    .filter((field) => field.required && !field.value.trim())
    .map((field) => field.label);
  if (!formValidated)
    missingQuestions.push("Employer form requires manual review");
  return {
    id: `app-${job.id}`,
    jobId: job.id,
    status: missingQuestions.length ? "needs_input" : "ready_to_send",
    coverLetter,
    coverLetterChat: [],
    formFields: fields,
    missingQuestions,
    adapter,
    liveFormValidated: formValidated,
    formSchema: schemaAudit,
    updatedAt: new Date().toISOString(),
  };
}

export function inferredWorkRegion(workspace: JobSearchWorkspace) {
  const location = confirmedLocation(workspace).toLowerCase();
  if (
    /slovak|košice|kosice|bratislava|europe|\bemea\b|austria|belgium|bulgaria|croatia|cyprus|czech|denmark|estonia|finland|france|germany|greece|hungary|iceland|ireland|italy|latvia|liechtenstein|lithuania|luxembourg|malta|netherlands|norway|poland|portugal|romania|slovenia|spain|sweden|switzerland|united kingdom|\buk\b/.test(
      location,
    )
  )
    return "Europe";
  if (/canada|united states|\busa\b|mexico/.test(location))
    return "North America";
  if (/argentina|bolivia|brazil|chile|colombia|ecuador|guyana|paraguay|peru|suriname|uruguay|venezuela/.test(location))
    return "South America";
  return "";
}

export function sourceDescription() {
  return "Other";
}

export function mappedValue(
  key: string,
  workspace: JobSearchWorkspace,
): { value: string; source: FormField["source"]; confidence: number } {
  const profile = workspace.profile;
  const shared = workspace.sharedAnswers?.[key] || "";
  const physicalLocationKey = [
    "current_location",
    "city",
    "state",
    "country",
    "intended_work_location",
  ].includes(key);
  if (
    shared &&
    !(physicalLocationKey && isGenericWorkplaceLocation(shared))
  )
    return { value: shared, source: "user", confidence: 100 };
  const location = confirmedLocation(workspace);
  const values: Record<string, string> = {
    name: profile.name,
    first_name: profile.name.trim().split(/\s+/)[0] || "",
    last_name: profile.name.trim().split(/\s+/).slice(1).join(" "),
    email: profile.email,
    phone: profile.phone,
    current_location: location,
    city: "",
    state: "",
    intended_work_location: location,
    country: countryFromLocation(location),
    start_date: /^\d{4}-\d{2}-\d{2}$/.test(profile.startDate)
      ? profile.startDate
      : "",
    notice_period: workspace.sharedAnswers?.start_date || profile.startDate,
    work_authorization: profile.workAuthorization,
    linkedin: profile.linkedin || sourceProfileUrl(workspace, "linkedin.com/in/"),
    github: profile.github || sourceProfileUrl(workspace, "github.com/"),
    website:
      profile.website ||
      workspace.sources.find(
        (source) => source.kind === "portfolio" || source.kind === "webpage",
      )?.url ||
      "",
  };
  const value = values[key] || "";
  return {
    value,
    source: value ? "profile" : "user",
    confidence: value ? 100 : 0,
  };
}

export function confirmedLocation(workspace: JobSearchWorkspace) {
  const location = workspace.profile.location.trim();
  return isGenericWorkplaceLocation(location) ? "" : location;
}

export function isGenericWorkplaceLocation(value: string) {
  return /^(?:remote|hybrid|anywhere|worldwide)$/i.test(value.trim());
}

export function countryFromLocation(location: string) {
  const country = location.split(",").at(-1)?.trim() || "";
  return country.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function canonicalFieldKey(label: string, externalName: string) {
  const value = `${label} ${externalName}`.toLowerCase();
  if (/\brace\b/.test(externalName.toLowerCase()) || /^race\b/i.test(label))
    return "eeoc_race";
  if (/ethnicity/.test(externalName.toLowerCase()) || /^(?:ethnicity|hispanic|latino)\b/i.test(label))
    return "eeoc_ethnicity";
  if (/legal.*first.*last.*name|first.*and.*last.*name|full name|systemfield_name/.test(value))
    return "name";
  if (/\b(first name|given name|pr[eé]nom)\b/.test(value)) return "first_name";
  if (/\b(last name|family name|surname|nom de famille|nom)\b/.test(value))
    return "last_name";
  if (/legal name|full name|systemfield_name/.test(value)) return "name";
  if (/email/.test(value)) return "email";
  if (/phone|mobile|t[eé]l[eé]phone/.test(value)) return "phone";
  if (/resume|curriculum|\bcv\b/.test(value)) return "cv";
  if (/which of these.*locations.*working from|north america.*south america.*europe/.test(value))
    return "work_region";
  if (/state.*(?:reside|residence)|residence.*state/.test(value)) return "state";
  if (/location\s*\(city\)|\bcity\b/.test(value)) return "city";
  if (/which country.*work|from which country.*work|country.*work from/.test(value))
    return "country";
  if (
    /anticipated work location|city.*country.*intend|which country.*work from|country.*intend.*work/.test(
      value,
    )
  )
    return "intended_work_location";
  if (/current.*locat|currently live|where.*located|home address/.test(value))
    return "current_location";
  if (/\bcountry\b/.test(value)) return "country";
  if (/start[-_ ]month|start date month/.test(value))
    return "education_start_month";
  if (/start[-_ ]year|start date year/.test(value))
    return "education_start_year";
  if (/end[-_ ]month|end date month/.test(value))
    return "education_end_month";
  if (/end[-_ ]year|end date year/.test(value))
    return "education_end_year";
  if (/education|school|university|degree|discipline|graduat/.test(value))
    return label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 80);
  if (/notice period/.test(value)) return "notice_period";
  if (/when.*start|start date|available from/.test(value))
    return "start_date";
  if (/authori[sz]ed to work/.test(value)) return "work_authorization";
  if (/sponsorship|visa status/.test(value)) return "sponsorship";
  if (/linkedin/.test(value)) return "linkedin";
  if (/github/.test(value)) return "github";
  if (/portfolio|website/.test(value)) return "website";
  if (/cover letter|lettre de motivation|motivation letter/.test(value))
    return "cover_letter";
  if (/position applied|poste.*(?:souhait|pourvu)|job.*apply/.test(value))
    return "target_position";
  if (/how did you hear|how.*find out about|comment.*(?:connu|trouv)/.test(value))
    return "job_source";
  if (/gender/.test(value)) return "eeoc_gender";
  if (/hispanic|latino|ethnicity/.test(value)) return "eeoc_ethnicity";
  if (/race/.test(value)) return "eeoc_race";
  if (/veteran/.test(value)) return "eeoc_veteran_status";
  if (/disability/.test(value)) return "eeoc_disability_status";
  if (/additional information|why.*role|motivation|\bmessage\b/.test(value))
    return "additional_information";
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 80);
}

export function cssEscape(value: string) {
  return value.replace(/(["\\])/g, "\\$1");
}

export function applicationControlSelector(externalName: string) {
  const escaped = cssEscape(externalName);
  return `[name="${escaped}"], [id="${escaped}"]`;
}
