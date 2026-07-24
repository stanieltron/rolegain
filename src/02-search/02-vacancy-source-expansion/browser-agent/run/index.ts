import type { Browser, Page } from "playwright";
import type { CodexExecClient } from "../../../../codex-runtime/client.js";
import { assertPublicHttpUrl } from "../../../../infrastructure/public-http.js";
import { guardPublicPage } from "../../../03-vacancy-validation/index.js";
import { captureVacancySourcePage } from "../../page-reader/index.js";
import type {
  SourceBrowserAgentState,
  SourceBrowserReplayStep,
  VacancySourcePage,
} from "../../contracts.js";
import type {
  SourceAgentControl,
  SourceAgentDecision,
  SourceBrowserAgentResult,
} from "../contracts.js";
import { observeSourcePage } from "../observe.js";
import {
  isLikelyVacancyLink,
  isSafeSourceContinuationControl,
} from "../policy.js";
import {
  buildInput as buildNavigationInput,
  command as NAVIGATION_COMMAND,
  outputSchema,
  rolePrompt,
} from "../llm-calls/01-source-navigation/index.js";

export interface RunSourceBrowserAgentInput {
  browser: Browser;
  codex: CodexExecClient;
  cwd: string;
  pageUrl: string;
  sourceName: string;
  state?: SourceBrowserAgentState;
  baselineUrls?: string[];
  targetNewLinks?: number;
}

/**
 * Open one interactive listing, replay its durable semantic continuation
 * recipe, and ask the model for a bounded sequence of additional actions.
 */
export async function runSourceBrowserAgent(
  input: RunSourceBrowserAgentInput,
): Promise<SourceBrowserAgentResult> {
  const sourceUrl = new URL(input.pageUrl);
  await assertPublicHttpUrl(sourceUrl);
  const page = await input.browser.newPage({ serviceWorkers: "block" });
  const originalState = input.state ?? emptyBrowserAgentState(input.pageUrl);
  const state: SourceBrowserAgentState = {
    ...originalState,
    replaySteps: originalState.replaySteps.map((step) => ({ ...step })),
    observedVacancyUrls: [...originalState.observedVacancyUrls],
    exhausted: false,
  };
  const baseline = new Set([
    ...state.observedVacancyUrls,
    ...(input.baselineUrls ?? []),
  ].map(normalizeUrl));
  const accumulatedLinks = new Map<string, { text: string; url: string }>();
  const targetNewLinks = Math.max(
    1,
    Math.min(100, input.targetNewLinks ?? 20),
  );
  const maxNewSteps = Math.max(
    1,
    Math.min(
      20,
      Number(process.env.ROLEGAIN_SOURCE_AGENT_STEPS_PER_RUN || 8),
    ),
  );
  const maxReplayActions = Math.max(
    10,
    Math.min(
      500,
      Number(process.env.ROLEGAIN_SOURCE_AGENT_MAX_REPLAY_ACTIONS || 120),
    ),
  );
  let currentSnapshot: VacancySourcePage | undefined;
  let newlyObserved = 0;
  let blocked = false;
  let noProgressSteps = 0;

  const capture = async () => {
    const current = new URL(page.url());
    if (current.hostname !== sourceUrl.hostname)
      throw new Error("Vacancy-source navigator attempted to leave its source host");
    await assertPublicHttpUrl(current);
    currentSnapshot = await captureVacancySourcePage(page);
    for (const link of currentSnapshot.links) {
      const key = normalizeUrl(link.url);
      if (key) accumulatedLinks.set(key, link);
    }
    newlyObserved = [...accumulatedLinks.values()].filter(
      (link) =>
        isLikelyVacancyLink(link, input.pageUrl) &&
        !baseline.has(normalizeUrl(link.url)),
    ).length;
    return currentSnapshot;
  };

  try {
    await guardPublicPage(page);
    const response = await page.goto(input.pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    if (!response?.ok())
      throw new Error(
        `Interactive vacancy source returned ${response?.status() ?? "no response"}`,
      );
    await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => undefined);
    await capture();

    const replayed: SourceBrowserReplayStep[] = [];
    let replayActions = 0;
    for (const step of state.replaySteps) {
      let completed = 0;
      for (
        let repetition = 0;
        repetition < step.repetitions && replayActions < maxReplayActions;
        repetition += 1
      ) {
        if (!(await executeReplayStep(page, step, input.pageUrl))) break;
        completed += 1;
        replayActions += 1;
        await settleSourcePage(page);
        await capture();
      }
      if (completed > 0)
        replayed.push({ ...step, repetitions: completed });
      if (completed < step.repetitions || replayActions >= maxReplayActions)
        break;
    }
    state.replaySteps = replayed;

    if (
      newlyObserved < targetNewLinks &&
      replayActionCount(state.replaySteps) < maxReplayActions
    ) {
      const runtime = await input.codex.start();
      const model =
        process.env.ROLEGAIN_FAST_MODEL ||
        runtime.models.find((item) => item.id === "gpt-5.4-mini")?.id ||
        runtime.model;
      const thread = await input.codex.startThread({
        cwd: input.cwd,
        callId: "search.source-navigation",
        role: NAVIGATION_COMMAND.role,
        sandbox: "read-only",
        model,
        approvalPolicy: NAVIGATION_COMMAND.approvalPolicy,
        developerInstructions: rolePrompt,
      });

      for (
        let stepIndex = 0;
        stepIndex < maxNewSteps && newlyObserved < targetNewLinks;
        stepIndex += 1
      ) {
        if (replayActionCount(state.replaySteps) >= maxReplayActions) {
          blocked = true;
          break;
        }
        const beforeLinks = accumulatedLinks.size;
        const observation = await observeSourcePage(
          page,
          accumulatedLinks.size,
          newlyObserved,
        );
        const result = await input.codex.runTurn({
          threadId: thread.id,
          cwd: input.cwd,
          sandbox: NAVIGATION_COMMAND.sandbox,
          model,
          effort: NAVIGATION_COMMAND.effort,
          timeoutMs: NAVIGATION_COMMAND.timeoutMs,
          outputSchema,
          prompt: buildNavigationInput({
            sourceName: input.sourceName,
            stepIndex,
            maxSteps: maxNewSteps,
            observation,
          }),
        });
        const decision = JSON.parse(result.finalText) as SourceAgentDecision;
        state.lastDecisionReason = decision.reason;
        if (decision.action === "stop") {
          state.exhausted = decision.completion === "exhausted";
          blocked = decision.completion !== "exhausted";
          break;
        }
        if (decision.completion !== "continue") {
          blocked = true;
          break;
        }
        if (decision.action === "wait") {
          await page.waitForTimeout(900);
        } else if (decision.action === "scroll") {
          await page.mouse.wheel(0, 1_100);
          appendReplayStep(state.replaySteps, {
            kind: "scroll",
            repetitions: 1,
          });
        } else {
          const control = observation.controls.find(
            (item) => item.id === decision.controlId,
          );
          if (
            !control ||
            !isSafeSourceContinuationControl(control, input.pageUrl) ||
            !(await clickObservedControl(page, control))
          ) {
            blocked = true;
            break;
          }
          appendReplayStep(state.replaySteps, {
            kind: "click",
            repetitions: 1,
            label: controlLabel(control),
            href: control.href || undefined,
          });
        }
        state.interactionsCompleted += 1;
        state.lastActionAt = new Date().toISOString();
        await settleSourcePage(page);
        await capture();
        noProgressSteps =
          accumulatedLinks.size > beforeLinks ? 0 : noProgressSteps + 1;
        if (noProgressSteps >= 3) {
          blocked = true;
          break;
        }
      }
    }

    const snapshot = currentSnapshot ?? (await capture());
    const vacancyUrls = [...accumulatedLinks.values()]
      .filter((link) => isLikelyVacancyLink(link, input.pageUrl))
      .map((link) => link.url);
    state.observedVacancyUrls = [
      ...new Set([...state.observedVacancyUrls, ...vacancyUrls]),
    ].slice(-20_000);
    state.lastObservedUrl = page.url();
    const allLinks = [...accumulatedLinks.values()].slice(-2_000);
    const merged: VacancySourcePage = {
      ...snapshot,
      links: allLinks,
      applyLinks: allLinks
        .filter((link) => /apply|application/i.test(link.text))
        .slice(0, 200),
      interactiveContinuation: !state.exhausted,
    };
    return {
      page: merged,
      state,
      hasMore:
        !state.exhausted &&
        !blocked &&
        replayActionCount(state.replaySteps) < maxReplayActions,
    };
  } finally {
    await page.close();
  }
}

export function appendReplayStep(
  recipe: SourceBrowserReplayStep[],
  step: SourceBrowserReplayStep,
) {
  const previous = recipe.at(-1);
  if (
    previous &&
    previous.kind === step.kind &&
    previous.label === step.label &&
    previous.href === step.href
  ) {
    previous.repetitions += step.repetitions;
  } else {
    recipe.push({ ...step });
  }
}

function emptyBrowserAgentState(pageUrl: string): SourceBrowserAgentState {
  return {
    version: 1,
    replaySteps: [],
    observedVacancyUrls: [],
    interactionsCompleted: 0,
    exhausted: false,
    lastObservedUrl: pageUrl,
    lastActionAt: "",
  };
}

async function executeReplayStep(
  page: Page,
  step: SourceBrowserReplayStep,
  sourceUrl: string,
) {
  if (step.kind === "scroll") {
    await page.mouse.wheel(0, 1_100);
    return true;
  }
  const observation = await observeSourcePage(page, 0, 0);
  const control = observation.controls.find((candidate) => {
    if (step.href && normalizeUrl(candidate.href) === normalizeUrl(step.href))
      return true;
    return Boolean(step.label) && controlLabel(candidate) === step.label;
  });
  return Boolean(
    control &&
      isSafeSourceContinuationControl(control, sourceUrl) &&
      (await clickObservedControl(page, control)),
  );
}

async function clickObservedControl(page: Page, control: SourceAgentControl) {
  const locator = page.locator(
    `[data-source-agent-action-id="${cssEscape(control.id)}"]`,
  );
  if ((await locator.count()) !== 1) return false;
  return locator
    .click({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
}

async function settleSourcePage(page: Page) {
  await page
    .waitForLoadState("domcontentloaded", { timeout: 4_000 })
    .catch(() => undefined);
  await page.waitForTimeout(700);
}

function replayActionCount(recipe: SourceBrowserReplayStep[]) {
  return recipe.reduce((total, step) => total + step.repetitions, 0);
}

function controlLabel(control: SourceAgentControl) {
  return `${control.text} ${control.ariaLabel} ${control.title}`
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return "";
  }
}

function cssEscape(value: string) {
  return value.replace(/(["\\])/g, "\\$1");
}
