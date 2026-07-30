import type { VacancyPageSnapshot } from "../../interpreter.js";

export function buildInput(input: {
  snapshot: VacancyPageSnapshot;
  lead: {
    title: string;
    company: string;
    location: string;
    applyUrl: string;
  };
}) {
  return `Interpret this captured page.

Discovery lead (a hint only; do not trust it over the captured page):
${JSON.stringify(input.lead, null, 2)}

Captured page:
${JSON.stringify(
  {
    pageUrl: input.snapshot.pageUrl,
    pageTitle: input.snapshot.pageTitle,
    metaDescription: input.snapshot.metaDescription,
    h1: input.snapshot.h1,
    headings: input.snapshot.headings.slice(0, 80),
    applyLinks: input.snapshot.applyLinks.slice(0, 30),
    partialStructuredData: input.snapshot.structured,
    visibleText: input.snapshot.bodyText.slice(0, 80_000),
  },
  null,
  2,
)}

Rules:
- pageType is vacancy only when this page describes one concrete position.
- Use closed_job/openStatus closed only when the current page explicitly says applications are closed, the job is filled, or the concrete vacancy/application route is gone. A stale valid-through date alone must not override a currently visible concrete vacancy with an active Apply route.
- Use unknown rather than guessing when the page is blocked or insufficient.
- description must contain the actual vacancy content, not navigation, cookie banners, company marketing, benefits-only text, or a search-result list.
- applyUrl must be one of the captured URLs or empty.
- publishedAt and validThrough must be copied only from explicit page dates or left empty.
- confidence is an integer from 0 to 100.
- sourceText must be a faithful excerpt present in the supplied captured page.
- List every unresolved conflict or ambiguity.`;
}

export const inputDescription =
  "One frozen vacancy snapshot, requested/resolved URL, visible links, and structured page data.";
