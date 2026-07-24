import type { Page } from "playwright";
import type { SourceAgentObservation } from "./contracts.js";

export async function observeSourcePage(
  page: Page,
  capturedLinkCount: number,
  newlyObservedLinkCount: number,
): Promise<SourceAgentObservation> {
  const controls = await page
    .locator('button:visible, a:visible, [role="button"]:visible')
    .evaluateAll((nodes) =>
      nodes.slice(0, 200).map((node, index) => {
        const id = `source-agent-action-${index + 1}`;
        node.setAttribute("data-source-agent-action-id", id);
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
  const pageText = await page.locator("body").innerText().catch(() => "");
  const scroll = await page.evaluate(() => ({
    top: window.scrollY,
    viewport: window.innerHeight,
    height: Math.max(
      document.body?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0,
    ),
  }));
  return {
    url: page.url(),
    title: await page.title(),
    pageText: pageText.replace(/\s+/g, " ").trim().slice(0, 20_000),
    controls,
    scroll,
    capturedLinkCount,
    newlyObservedLinkCount,
  };
}
