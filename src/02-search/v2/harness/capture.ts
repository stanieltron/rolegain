import { load } from "cheerio";
import type { Browser, Page } from "playwright";
import { assertPublicHttpUrl } from "../../../infrastructure/public-http.js";
import type {
  SearchV2Capture,
  SearchV2JobPosting,
  SearchV2Lead,
  SearchV2Link,
  SearchV2Signals,
} from "../contracts.js";
import type { SearchV2Configuration } from "../config.js";

const relevantLinkPattern =
  /job|career|position|opening|apply|engineer|developer|manager|analyst|research|architect|protocol/i;
const definiteClosurePattern =
  /applications? for this job (?:are|is) (?:currently )?closed|this job is closed|position (?:has been |is )?filled|job (?:has been |is )?(?:closed|expired|unavailable)|no longer accepting applications?|applications? (?:are )?closed|vacancy (?:has been |is )?closed/i;
const conditionalClosurePattern =
  /(?:may|might|could) no longer (?:be )?accepting|possibly closed|may have expired/i;
const staffingPoolPattern =
  /open application|general application|talent pool|talent community|expression of interest|matched with (?:one of )?(?:several|multiple|ecosystem) teams|roles vary from|future opportunities/i;
const applicationLoadingPattern =
  /loading (?:the )?application(?: form)?|application (?:form )?loading/i;

export async function captureSearchV2Leads(input: {
  browser: Browser;
  leads: SearchV2Lead[];
  configuration: SearchV2Configuration;
}): Promise<SearchV2Capture[]> {
  return mapConcurrent(
    input.leads,
    input.configuration.captureConcurrency,
    (lead) => captureOne(input.browser, lead, input.configuration),
  );
}

async function captureOne(
  browser: Browser,
  lead: SearchV2Lead,
  configuration: SearchV2Configuration,
): Promise<SearchV2Capture> {
  const supplied = new URL(lead.url);
  await assertPublicHttpUrl(supplied);
  const page = await browser.newPage({ serviceWorkers: "block" });
  let httpStatus = 0;
  let navigationError = "";
  try {
    const response = await page.goto(lead.url, {
      waitUntil: "domcontentloaded",
      timeout: configuration.navigationTimeoutMs,
    });
    httpStatus = response?.status() || 0;
    if (configuration.settleMs) await page.waitForTimeout(configuration.settleMs);
  } catch (error) {
    navigationError = error instanceof Error ? error.message : String(error);
  }

  let observed = await observePage(page).catch((error) => ({
    finalUrl: page.url(),
    pageTitle: "",
    body: "",
    links: [] as SearchV2Link[],
    forms: [] as SearchV2Capture["forms"],
    jobPosting: undefined,
    captureError: error instanceof Error ? error.message : String(error),
  }));
  await page.close();

  let fallback: SearchV2Capture["fallback"];
  if (
    observed.body.trim().length < 100 ||
    navigationError ||
    httpStatus >= 400
  ) {
    const recovered = await fetchPage(lead.url, configuration.navigationTimeoutMs);
    fallback = {
      status: recovered.status,
      finalUrl: recovered.finalUrl,
      contentType: recovered.contentType,
      error: recovered.error,
      recovered: recovered.body.length > observed.body.length,
    };
    if (recovered.body.length > observed.body.length)
      observed = {
        ...observed,
        finalUrl: recovered.finalUrl,
        pageTitle: recovered.pageTitle || observed.pageTitle,
        body: recovered.body,
        links: recovered.links.length ? recovered.links : observed.links,
        jobPosting: recovered.jobPosting || observed.jobPosting,
      };
    if (!httpStatus) httpStatus = recovered.status;
  }

  const capture: Omit<SearchV2Capture, "signals"> = {
    id: lead.id,
    lead,
    suppliedUrl: lead.url,
    finalUrl:
      /^https?:/i.test(observed.finalUrl) ? observed.finalUrl : lead.url,
    httpStatus,
    navigationError,
    pageTitle: clean(observed.pageTitle),
    body: normalizeBody(observed.body).slice(0, 50_000),
    links: deduplicateLinks(observed.links).slice(0, 100),
    forms: observed.forms.slice(0, 8),
    jobPosting: observed.jobPosting,
    fallback,
  };
  return { ...capture, signals: extractSignals(capture) };
}

async function observePage(page: Page) {
  return page.evaluate(() => {
    const relevantLink =
      /job|career|position|opening|apply|engineer|developer|manager|analyst|research|architect|protocol/i;
    const cleanText = (value: unknown) =>
      String(value || "").replace(/\s+/g, " ").trim();
    const parsePosting = (): SearchV2JobPosting | undefined => {
      const visit = (value: unknown): Record<string, unknown> | undefined => {
        if (!value || typeof value !== "object") return undefined;
        if (Array.isArray(value)) {
          for (const child of value) {
            const match = visit(child);
            if (match) return match;
          }
          return undefined;
        }
        const record = value as Record<string, unknown>;
        const type = record["@type"];
        if (
          type === "JobPosting" ||
          (Array.isArray(type) && type.includes("JobPosting"))
        )
          return record;
        for (const child of Object.values(record)) {
          const match = visit(child);
          if (match) return match;
        }
        return undefined;
      };
      for (const script of document.querySelectorAll(
        'script[type="application/ld+json"]',
      )) {
        try {
          const posting = visit(JSON.parse(script.textContent || ""));
          if (!posting) continue;
          const organization = posting.hiringOrganization as
            | Record<string, unknown>
            | undefined;
          const locations = Array.isArray(posting.jobLocation)
            ? posting.jobLocation
            : [posting.jobLocation];
          const location = locations
            .map((item) => {
              const place = item as Record<string, unknown> | undefined;
              const address = place?.address as Record<string, unknown> | undefined;
              return [address?.addressLocality, address?.addressRegion, address?.addressCountry]
                .filter(Boolean)
                .join(", ");
            })
            .filter(Boolean)
            .join(" | ");
          const container = document.createElement("div");
          container.innerHTML = String(posting.description || "");
          return {
            title: cleanText(posting.title),
            company: cleanText(organization?.name),
            description: cleanText(container.innerText || container.textContent),
            location: cleanText(location),
            employmentType: cleanText(posting.employmentType),
            datePosted: cleanText(posting.datePosted),
            validThrough: cleanText(posting.validThrough),
            url: cleanText(posting.url),
          };
        } catch {
          // Ignore malformed third-party structured data.
        }
      }
      return undefined;
    };
    return {
      finalUrl: location.href,
      pageTitle: document.title,
      body: String(document.body?.innerText || "").slice(0, 50_000),
      links: [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
        .map((link) => ({ text: cleanText(link.textContent), url: link.href }))
        .filter((link) => relevantLink.test(`${link.text} ${link.url}`))
        .slice(0, 120),
      forms: [...document.querySelectorAll<HTMLFormElement>("form")]
        .slice(0, 8)
        .map((form) => ({
          action: form.action,
          text: cleanText(form.innerText).slice(0, 800),
          fields: form.querySelectorAll(
            "input:not([type=hidden]),textarea,select",
          ).length,
        })),
      jobPosting: parsePosting(),
    };
  });
}

async function fetchPage(url: string, timeoutMs: number) {
  let current = url;
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    try {
      const parsed = new URL(current);
      await assertPublicHttpUrl(parsed);
      const response = await fetch(parsed, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "user-agent": "Mozilla/5.0 RolegainDiscoveryV2/1.0",
          accept: "text/html,application/xhtml+xml",
        },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) break;
        current = new URL(location, parsed).toString();
        continue;
      }
      const contentType = response.headers.get("content-type") || "";
      const html = await response.text();
      const $ = load(html);
      $("script,style,noscript").remove();
      const links = $("a[href]")
        .toArray()
        .map((element) => {
          const href = $(element).attr("href") || "";
          try {
            return {
              text: clean($(element).text()),
              url: new URL(href, response.url || current).toString(),
            };
          } catch {
            return { text: "", url: "" };
          }
        })
        .filter((link) =>
          relevantLinkPattern.test(`${link.text} ${link.url}`),
        );
      const jobPosting = parseHtmlJobPosting(html);
      return {
        status: response.status,
        finalUrl: response.url || current,
        contentType,
        pageTitle: clean($("title").first().text()),
        body: normalizeBody($("body").text()).slice(0, 50_000),
        links,
        jobPosting,
        error: "",
      };
    } catch (error) {
      return {
        status: 0,
        finalUrl: current,
        contentType: "",
        pageTitle: "",
        body: "",
        links: [] as SearchV2Link[],
        jobPosting: undefined,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return {
    status: 0,
    finalUrl: current,
    contentType: "",
    pageTitle: "",
    body: "",
    links: [] as SearchV2Link[],
    jobPosting: undefined,
    error: "Too many redirects",
  };
}

function parseHtmlJobPosting(html: string): SearchV2JobPosting | undefined {
  const $ = load(html);
  for (const element of $('script[type="application/ld+json"]').toArray()) {
    try {
      const found = findJobPosting(JSON.parse($(element).text()));
      if (!found) continue;
      const organization = asRecord(found.hiringOrganization);
      const location = [found.jobLocation]
        .flat()
        .map((item) => asRecord(asRecord(item)?.address))
        .map((address) =>
          [address?.addressLocality, address?.addressRegion, address?.addressCountry]
            .filter(Boolean)
            .join(", "),
        )
        .filter(Boolean)
        .join(" | ");
      return {
        title: clean(found.title),
        company: clean(organization?.name),
        description: normalizeBody(load(String(found.description || "")).text()),
        location,
        employmentType: clean(found.employmentType),
        datePosted: clean(found.datePosted),
        validThrough: clean(found.validThrough),
        url: clean(found.url),
      };
    } catch {
      // Continue through malformed scripts.
    }
  }
  return undefined;
}

function findJobPosting(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const child of value) {
      const match = findJobPosting(child);
      if (match) return match;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const type = record["@type"];
  if (
    type === "JobPosting" ||
    (Array.isArray(type) && type.includes("JobPosting"))
  )
    return record;
  for (const child of Object.values(record)) {
    const match = findJobPosting(child);
    if (match) return match;
  }
  return undefined;
}

export function extractSignals(
  capture: Omit<SearchV2Capture, "signals">,
): SearchV2Signals {
  const body = normalizeBody(capture.body);
  return {
    pageTitleMatchesExpected: includesTitle(
      capture.pageTitle,
      capture.lead.title,
    ),
    expectedTitleContext: contextAround(body, capture.lead.title),
    definiteClosureContext: regexContext(body, definiteClosurePattern),
    conditionalClosureContext: regexContext(body, conditionalClosurePattern),
    staffingPoolContext: regexContext(body, staffingPoolPattern),
    applicationLoadingContext: regexContext(body, applicationLoadingPattern),
    matchingLinks: capture.links
      .filter((link) => includesTitle(link.text, capture.lead.title))
      .slice(0, 12),
    relevantLinkCount: capture.links.length,
    formCount: capture.forms.length,
    hasUsableEvidence: Boolean(
      capture.pageTitle ||
        body.length >= 100 ||
        includesTitle(body, capture.lead.title) ||
        capture.jobPosting ||
        capture.links.length,
    ),
  };
}

export function inaccessibleDecision(capture: SearchV2Capture) {
  if (capture.signals.hasUsableEvidence) return undefined;
  return {
    id: capture.id,
    status: "reject" as const,
    reason: "The browser and HTTP fallback produced no usable current-page evidence.",
    title: capture.lead.title,
    company: capture.lead.company,
    location: capture.lead.location,
    workplaceType: capture.lead.workplaceType,
    employmentType: capture.lead.employmentType,
    applyUrl: capture.finalUrl || capture.suppliedUrl,
    compensation: capture.lead.compensation,
    children: [],
  };
}

function contextAround(text: string, needle: string, radius = 280) {
  const index = text.toLowerCase().indexOf(clean(needle).toLowerCase());
  if (index < 0) return "";
  return text.slice(Math.max(0, index - radius), index + needle.length + radius);
}

function regexContext(text: string, pattern: RegExp, radius = 280) {
  const match = pattern.exec(text);
  if (!match) return "";
  return text.slice(
    Math.max(0, match.index - radius),
    match.index + match[0].length + radius,
  );
}

function includesTitle(text: string, title: string) {
  const haystack = normalizeIdentity(text);
  const needle = normalizeIdentity(title);
  return Boolean(
    haystack && needle && (haystack.includes(needle) || needle.includes(haystack)),
  );
}

function normalizeIdentity(value: string) {
  return clean(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeBody(value: string) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clean(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function deduplicateLinks(links: SearchV2Link[]) {
  const seen = new Set<string>();
  return links.filter((link) => {
    if (!/^https?:/i.test(link.url)) return false;
    const key = `${clean(link.text).toLowerCase()}::${link.url.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await mapper(items[index], index);
      }
    }),
  );
  return results;
}
