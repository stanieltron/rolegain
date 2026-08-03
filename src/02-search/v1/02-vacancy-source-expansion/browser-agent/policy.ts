import type { VacancySourcePage } from "../contracts.js";
import type { SourceAgentControl } from "./contracts.js";

const CONTINUATION = /(?:^|\b)(?:next|older|load more|show more|view more|more jobs|more roles|more results|weitere|mehr anzeigen|voir plus|afficher plus|suivant|ďalšie|zobraziť viac|načíst další)(?:\b|$)|^[›»>]$/i;
const UNSAFE = /apply|application|submit|send|sign[ -]?in|log[ -]?in|register|create account|accept|agree|terms|privacy settings|subscribe|checkout|payment/i;

export function isSafeSourceContinuationControl(
  control: SourceAgentControl,
  sourceUrl: string,
) {
  if (control.disabled) return false;
  const label = `${control.text} ${control.ariaLabel} ${control.title}`
    .replace(/\s+/g, " ")
    .trim();
  if (!CONTINUATION.test(label) || UNSAFE.test(label)) return false;
  if (!control.href) return true;
  try {
    return new URL(control.href, sourceUrl).hostname === new URL(sourceUrl).hostname;
  } catch {
    return false;
  }
}

export function isLikelyVacancyLink(
  link: { text: string; url: string },
  sourceUrl: string,
) {
  try {
    const target = new URL(link.url, sourceUrl);
    const source = new URL(sourceUrl);
    if (target.hostname !== source.hostname || target.href === source.href)
      return false;
    const value = `${target.pathname} ${target.search} ${link.text}`.toLowerCase();
    if (/privacy|terms|cookie|login|signin|register|about|contact|facebook|linkedin|instagram/.test(value))
      return false;
    return /job|jobs|career|position|opening|vacanc|role|opportunit|requisition|posting/.test(
      value,
    );
  } catch {
    return false;
  }
}

export function shouldUseSourceBrowserAgent(
  page: VacancySourcePage,
  batchSize: number,
) {
  if (process.env.ROLEGAIN_SOURCE_BROWSER_AGENT === "disabled") return false;
  if (page.nextUrl) return false;
  const likelyLinks = page.links.filter((link) =>
    isLikelyVacancyLink(link, page.pageUrl),
  ).length;
  return page.interactiveContinuation || likelyLinks >= Math.max(8, batchSize);
}
