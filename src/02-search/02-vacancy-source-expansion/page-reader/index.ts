import type { Browser, Page } from "playwright";
import { assertPublicHttpUrl } from "../../../infrastructure/public-http.js";
import { guardPublicPage } from "../../03-vacancy-validation/index.js";
import type { VacancySourcePage } from "../contracts.js";

/** Acquire one immutable public vacancy-source page and its continuation URL. */
export async function readVacancySourcePage(
  browser: Browser,
  pageUrl: string,
): Promise<VacancySourcePage> {
  await assertPublicHttpUrl(new URL(pageUrl));
  const page = await browser.newPage({ serviceWorkers: "block" });
  try {
    await guardPublicPage(page);
    let response;
    try {
      response = await page.goto(pageUrl, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
    } catch (error) {
      if (!/Download is starting/i.test(String(error))) throw error;
    }
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    const captured = await captureVacancySourcePage(page);
    if (
      !response?.ok() &&
      !(captured.bodyText.length >= 300 && captured.links.length >= 5)
    )
      throw new Error(
        `Vacancy source returned ${response?.status() ?? "no response"}`,
      );
    return captured;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Capture the current state of an already-open source page. */
export async function captureVacancySourcePage(
  page: Page,
): Promise<VacancySourcePage> {
  const captured = (await page.evaluate(`(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const absolute = (value) => {
        try { return new URL(value, document.baseURI).toString(); } catch { return ""; }
      };
      const anchors = Array.from(document.querySelectorAll("a[href]")).map((node) => ({
        text: clean(node.textContent || node.getAttribute("aria-label")),
        url: absolute(node.getAttribute("href")),
        rel: clean(node.getAttribute("rel")).toLowerCase(),
        current: clean(node.getAttribute("aria-current")).toLowerCase(),
      })).filter((item) => item.url);
      const explicitNext = anchors.find((item) =>
        item.rel.split(/\\s+/).includes("next") || /^(?:next|older|more|›|»|>)$/i.test(item.text)
      );
      const currentIndex = anchors.findIndex((item) => item.current === "page");
      const numericNext = currentIndex >= 0
        ? anchors.slice(currentIndex + 1).find((item) => /^\\d+$/.test(item.text))
        : undefined;
      const applyLinks = anchors.filter((item) => /apply|application/i.test(item.text));
      const continuationText = Array.from(document.querySelectorAll('button, [role="button"], a[href]'))
        .filter((node) => node.getClientRects().length > 0)
        .map((node) => clean([node.textContent, node.getAttribute("aria-label"), node.getAttribute("title")].join(" ")))
        .join(" | ");
      const bodyText = clean(document.body?.innerText);
      const hasCountHint = /(?:showing|displaying|results?)\\s+\\d+[\\s–-]+\\d+\\s+(?:of|from)\\s+\\d+/i.test(bodyText);
      return {
        pageUrl: location.href,
        nextUrl: explicitNext?.url || numericNext?.url || "",
        pageTitle: clean(document.title),
        metaDescription: clean(document.querySelector('meta[name="description"]')?.getAttribute("content")),
        h1: clean(document.querySelector("h1")?.textContent),
        headings: Array.from(document.querySelectorAll("h1,h2,h3")).map((node) => clean(node.textContent)).filter(Boolean),
        bodyText: bodyText.slice(0, 120000),
        applyLinks: applyLinks.slice(0, 100).map(({ text, url }) => ({ text, url })),
        links: anchors.slice(0, 1000).map(({ text, url }) => ({ text, url })),
        interactiveContinuation: hasCountHint || /load more|show more|view more|more jobs|next jobs|older jobs|weitere|mehr anzeigen|voir plus|afficher plus|ďalšie|zobraziť viac/i.test(continuationText),
      };
    })()`)) as VacancySourcePage;
  if (captured.nextUrl) {
    const current = new URL(captured.pageUrl);
    const next = new URL(captured.nextUrl);
    if (current.hostname !== next.hostname) captured.nextUrl = undefined;
    else await assertPublicHttpUrl(next);
  }
  return captured;
}
