import { createHash } from "node:crypto";
import { extname } from "node:path";
import * as cheerio from "cheerio";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { chromium, type Page } from "playwright";
import WordExtractor from "word-extractor";
import type { CandidateSource } from "../../../contracts/job-search.js";
import { assertPublicHttpUrl } from "../../../infrastructure/public-http.js";

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_WEB_BYTES = 3 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 400_000;
const MAX_RENDERED_PAGES = 12;

export interface SupplementalEvidenceInput {
  kind: Exclude<CandidateSource["kind"], "cv">;
  name: string;
  url?: string;
  content?: string;
  dataBase64?: string;
  mimeType?: string;
}

export interface SupplementalEvidence {
  kind: Exclude<CandidateSource["kind"], "cv">;
  name: string;
  url?: string;
  content: string;
  /** SHA-256 of normalized extracted text, used only to prevent duplicates. */
  contentHash: string;
  /** Additional independently analyzed sources discovered from an aggregate source. */
  relatedSources?: SupplementalEvidence[];
}

interface AcquiredSource {
  kind: Exclude<CandidateSource["kind"], "cv">;
  name: string;
  url?: string;
  content: string;
  rawContent?: string;
  renderedContent?: string;
  mimeType?: string;
  size: number;
  relatedSources?: AcquiredSource[];
}

export async function readSupplementalEvidence(
  input: SupplementalEvidenceInput,
  signal?: AbortSignal,
): Promise<SupplementalEvidence> {
  signal?.throwIfAborted();
  const name = input.name.trim() || "Source";
  if (input.url) {
    const url = normalizeWebUrl(input.url);
    if (!url) throw new Error("Enter a valid HTTP or HTTPS website URL");
    return finalizeSupplementalEvidence(
      await ingestUrl({ ...input, name, url: url.href }, signal),
    );
  }
  const contentUrl =
    input.kind === "document" && typeof input.content === "string"
      ? normalizeWebUrl(input.content)
      : undefined;
  if (contentUrl)
    return finalizeSupplementalEvidence(
      await ingestUrl({
        ...input,
        kind: "webpage",
        name: contentUrl.hostname,
        url: contentUrl.href,
      }, signal),
    );
  if (typeof input.content === "string") {
    return finalizeSupplementalEvidence(
      { kind: input.kind, name, content: ensureSupportedLength(cleanText(input.content), name), mimeType: input.mimeType || "text/plain", size: Buffer.byteLength(input.content) },
    );
  }
  if (!input.dataBase64) throw new Error("The source has no readable content");
  const buffer = decodeBase64(input.dataBase64);
  const content = await extractDocument(buffer, name, input.mimeType);
  return finalizeSupplementalEvidence(
    { kind: input.kind, name, content, mimeType: input.mimeType, size: buffer.length },
  );
}

function finalizeSupplementalEvidence(
  source: AcquiredSource,
): SupplementalEvidence {
  const content = cleanText(source.content);
  return {
    kind: source.kind,
    name: source.name,
    url: source.url,
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
    relatedSources: source.relatedSources?.map((item) =>
      finalizeSupplementalEvidence(item),
    ),
  };
}

async function ingestUrl(
  input: SupplementalEvidenceInput & { url: string; name: string },
  signal?: AbortSignal,
): Promise<AcquiredSource> {
  const url = new URL(input.url);
  if (url.hostname.toLowerCase() === "github.com")
    return ingestGithub(url, input.name, signal);
  const fetched = await fetchPublic(url, {}, signal);
  const name = input.name || filenameFromUrl(fetched.url) || fetched.url.hostname;
  let content: string;
  if (isHtml(fetched.contentType)) {
    const rawContent = fetched.buffer.toString("utf8");
    const fallback = htmlToText(rawContent, fetched.url);
    content = await renderWebsite(fetched.url, signal).catch(() => {
      signal?.throwIfAborted();
      return fallback;
    });
    return {
      kind: input.kind,
      name,
      url: fetched.url.href,
      content: ensureSupportedLength(content, name),
      rawContent,
      renderedContent: content,
      mimeType: fetched.contentType,
      size: fetched.buffer.length,
    };
  } else {
    content = await extractDocument(fetched.buffer, name, fetched.contentType);
  }
  return { kind: input.kind, name, url: fetched.url.href, content: ensureSupportedLength(content, name), mimeType: fetched.contentType, size: fetched.buffer.length };
}

export function normalizeWebUrl(value: string): URL | undefined {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return undefined;
  const candidate = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : /^(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(trimmed)
      ? `https://${trimmed}`
      : "";
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

async function ingestGithub(
  url: URL,
  fallbackName: string,
  signal?: AbortSignal,
): Promise<AcquiredSource> {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 1) throw new Error("GitHub URL must point to a profile or repository");
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "Job-Apply-Go" };
  if (parts.length === 1) {
    const [profileResponse, reposResponse] = await Promise.all([
      fetchPublic(new URL(`https://api.github.com/users/${encodeURIComponent(parts[0])}`), headers, signal),
      fetchPublic(new URL(`https://api.github.com/users/${encodeURIComponent(parts[0])}/repos?sort=updated&per_page=12`), headers, signal),
    ]);
    const profile = JSON.parse(profileResponse.buffer.toString("utf8")) as Record<string, unknown>;
    const repos = JSON.parse(reposResponse.buffer.toString("utf8")) as Array<Record<string, unknown>>;
    const repositorySources: AcquiredSource[] = [];
    let repositoryBytes = 0;
    for (let index = 0; index < repos.length; index += 3) {
      const batch = await Promise.all(
        repos.slice(index, index + 3).map(async (repo) => {
          const fullName = String(repo.full_name || "");
          const [owner, name] = fullName.split("/");
          const supplement = owner && name
            ? await githubRepositorySupplement(
                `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
                String(repo.default_branch || "main"),
                headers,
                signal,
              )
            : { content: "", size: 0 };
          return {
            size: supplement.size,
            source: {
              kind: "repository" as const,
              name: fullName || String(repo.name || "Repository"),
              url: String(repo.html_url || `https://github.com/${fullName}`),
              content: cleanText([
                `Repository: ${fullName || repo.name}`,
                `Description: ${repo.description || ""}`,
                `Primary language: ${repo.language || ""}`,
                `Topics: ${Array.isArray(repo.topics) ? repo.topics.join(", ") : ""}`,
                `Stars: ${repo.stargazers_count || 0}; forks: ${repo.forks_count || 0}`,
                supplement.content,
              ].filter(Boolean).join("\n")),
              mimeType: "application/vnd.github+json",
              size: supplement.size,
            },
          };
        }),
      );
      repositorySources.push(...batch.map((item) => item.source));
      repositoryBytes += batch.reduce((total, item) => total + item.size, 0);
    }
    const content = ensureSupportedLength([
      `GitHub profile: ${profile.name || profile.login}`,
      `Bio: ${profile.bio || ""}`,
      `Location: ${profile.location || ""}`,
      `Public repositories: ${profile.public_repos || repos.length}`,
      "",
      "Repositories discovered as independent evidence sources:",
      ...repositorySources.map(
        (source) => `- ${source.name}: ${source.url || ""}`,
      ),
    ].join("\n\n"), fallbackName);
    return { kind: "github", name: String(profile.name || profile.login || fallbackName), url: url.href, content: cleanText(content), mimeType: "application/vnd.github+json", size: profileResponse.buffer.length + reposResponse.buffer.length + repositoryBytes, relatedSources: repositorySources };
  }

  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  const apiBase = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const [repoResponse, languagesResponse] = await Promise.all([
    fetchPublic(new URL(apiBase), headers, signal),
    fetchPublic(new URL(`${apiBase}/languages`), headers, signal),
  ]);
  const metadata = JSON.parse(repoResponse.buffer.toString("utf8")) as Record<string, unknown>;
  const languages = JSON.parse(languagesResponse.buffer.toString("utf8")) as Record<string, number>;
  const supplement = await githubRepositorySupplement(
    apiBase,
    String(metadata.default_branch || "main"),
    headers,
    signal,
  );
  const content = [
    `Repository: ${metadata.full_name || `${owner}/${repo}`}`,
    `Description: ${metadata.description || ""}`,
    `Primary language: ${metadata.language || ""}`,
    `Languages: ${Object.keys(languages).join(", ")}`,
    `Topics: ${Array.isArray(metadata.topics) ? metadata.topics.join(", ") : ""}`,
    `Stars: ${metadata.stargazers_count || 0}; forks: ${metadata.forks_count || 0}`,
    "",
    supplement.content,
  ].join("\n");
  return { kind: "repository", name: String(metadata.full_name || fallbackName), url: String(metadata.html_url || url.href), content: cleanText(content), mimeType: "application/vnd.github+json", size: repoResponse.buffer.length + languagesResponse.buffer.length + supplement.size };
}

async function githubRepositorySupplement(
  apiBase: string,
  defaultBranch: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
) {
  const rawHeaders = { ...headers, Accept: "application/vnd.github.raw+json" };
  const [readme, treeResponse] = await Promise.all([
    fetchPublic(new URL(`${apiBase}/readme`), rawHeaders, signal).catch(() => null),
    fetchPublic(
      new URL(
        `${apiBase}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
      ),
      headers,
      signal,
    ).catch(() => null),
  ]);
  const parsedTree = treeResponse
    ? (JSON.parse(treeResponse.buffer.toString("utf8")) as {
        sha?: string;
        tree?: Array<{ path?: string; type?: string; size?: number }>;
      })
    : undefined;
  const commitSha = parsedTree?.sha || "unknown";
  const tree = parsedTree?.tree || [];
  const files = tree
    .filter((item) => item.type === "blob" && item.path)
    .map((item) => item.path!);
  const manifest = [
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "requirements.txt",
    "foundry.toml",
    "hardhat.config.ts",
  ].flatMap((name) => files.filter((file) => file === name || file.endsWith(`/${name}`))).at(0);
  const keySource = files
    .filter(
      (file) =>
        /\.(?:c|cc|cpp|cs|go|java|js|jsx|php|py|rb|rs|sol|swift|ts|tsx)$/i.test(file) &&
        !/(?:^|\/)(?:dist|build|coverage|generated|node_modules|test|tests|vendor)(?:\/|$)/i.test(file),
    )
    .sort((a, b) => sourcePathScore(b) - sourcePathScore(a) || a.localeCompare(b))
    .at(0);
  const selected = [...new Set([manifest, keySource].filter((file): file is string => Boolean(file)))];
  const fileResponses = await Promise.all(
    selected.map(async (file) => ({
      file,
      response: await fetchPublic(
        new URL(`${apiBase}/contents/${file.split("/").map(encodeURIComponent).join("/")}`),
        rawHeaders,
        signal,
      ).catch(() => null),
    })),
  );
  const content = [
    `Repository commit: ${commitSha}`,
    "### File: README.md",
    clipGithubText(readme?.buffer.toString("utf8") || "README unavailable"),
    ...fileResponses.flatMap(({ file, response }) =>
      response
        ? [`### File: ${file}`, clipGithubText(response.buffer.toString("utf8"))]
        : [],
    ),
  ].join("\n\n");
  return {
    content,
    size:
      (readme?.buffer.length || 0) +
      (treeResponse?.buffer.length || 0) +
      fileResponses.reduce(
        (total, item) => total + (item.response?.buffer.length || 0),
        0,
      ),
  };
}

function sourcePathScore(file: string) {
  let score = 0;
  if (/(?:^|\/)src\//i.test(file)) score += 4;
  if (/(?:^|\/)(?:index|main|app|server|core)\.[^.]+$/i.test(file)) score += 4;
  score -= file.split("/").length;
  return score;
}

function clipGithubText(value: string) {
  const maxChars = 8_000;
  return value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars)}\n\n[File clipped after ${maxChars.toLocaleString()} characters]`;
}

async function extractDocument(buffer: Buffer, name: string, mimeType?: string): Promise<string> {
  if (buffer.length === 0) throw new Error("The uploaded file is empty");
  if (buffer.length > MAX_FILE_BYTES) throw new Error("Files larger than 15 MB are not supported");
  const extension = extname(name).toLowerCase();
  const type = (mimeType || "").toLowerCase();
  if (extension === ".pdf" || type.includes("pdf")) {
    const parser = new PDFParse({ data: buffer });
    try { return ensureReadable((await parser.getText()).text, "PDF"); } finally { await parser.destroy(); }
  }
  if (extension === ".docx" || type.includes("officedocument.wordprocessingml")) {
    return ensureReadable((await mammoth.extractRawText({ buffer })).value, "Word document");
  }
  if (extension === ".doc" || type === "application/msword") {
    return ensureReadable((await new WordExtractor().extract(buffer)).getBody(), "Word document");
  }
  if ([".txt", ".md", ".markdown", ".rtf", ".csv", ".json", ".html", ".htm"].includes(extension) || type.startsWith("text/") || type.includes("json")) {
    const text = buffer.toString("utf8");
    return ensureReadable(extension === ".html" || extension === ".htm" || type.includes("html") ? htmlToText(text) : text, "text document");
  }
  throw new Error("Unsupported file type. Upload PDF, DOC, DOCX, TXT, MD, RTF, HTML or JSON");
}

async function renderWebsite(initialUrl: URL, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  await assertPublicHttpUrl(initialUrl);
  const browser = await chromium.launch({ headless: true });
  const abort = () => void browser.close();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    const allowedOrigin = initialUrl.origin;
    const checkedHosts = new Map<string, boolean>();
    await context.route("**/*", async (route) => {
      const request = route.request();
      const resourceType = request.resourceType();
      if (["image", "media", "font"].includes(resourceType)) {
        await route.abort();
        return;
      }
      try {
        const requestUrl = new URL(request.url());
        if (requestUrl.origin !== allowedOrigin) {
          await route.abort();
          return;
        }
        if (!checkedHosts.has(requestUrl.hostname)) {
          await assertPublicHttpUrl(requestUrl);
          checkedHosts.set(requestUrl.hostname, true);
        }
        await route.continue();
      } catch {
        await route.abort();
      }
    });

    const page = await context.newPage();
    const queue = [initialUrl.href];
    const visited = new Set<string>();
    const pages: string[] = [];
    while (queue.length > 0 && visited.size < MAX_RENDERED_PAGES) {
      signal?.throwIfAborted();
      const next = new URL(queue.shift()!);
      next.hash = "";
      if (next.origin !== allowedOrigin || visited.has(next.href)) continue;
      visited.add(next.href);
      const response = await page.goto(next.href, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      if (!response?.ok()) continue;
      await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => undefined);
      await page.waitForTimeout(250);
      await expandReadableDisclosures(page);
      const finalUrl = new URL(page.url());
      await assertPublicHttpUrl(finalUrl);
      if (finalUrl.origin !== allowedOrigin) continue;
      const rendered = await page.evaluate(() => {
        const main = document.querySelector("main, article, [role=main]");
        return {
          title: document.title,
          description:
            document.querySelector('meta[name="description"]')?.getAttribute("content") || "",
          text: (main?.textContent || document.body?.textContent || "").trim(),
          links: Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
            .filter((link) => !link.hasAttribute("download"))
            .map((link) => link.href),
        };
      });
      const pageText = cleanText(
        [`Page: ${finalUrl.href}`, rendered.title, rendered.description, rendered.text]
          .filter(Boolean)
          .join("\n"),
      );
      if (pageText.length >= 20) pages.push(pageText);
      for (const href of rendered.links) {
        try {
          const linked = new URL(href);
          linked.hash = "";
          if (
            linked.origin === allowedOrigin &&
            !visited.has(linked.href) &&
            !isAssetPath(linked.pathname)
          )
            queue.push(linked.href);
        } catch {
          // Ignore malformed links emitted by the page.
        }
      }
      queue.sort((left, right) => websitePathPriority(right) - websitePathPriority(left));
    }
    return ensureReadable(cleanText(pages.join("\n\n")), "Website");
  } finally {
    signal?.removeEventListener("abort", abort);
    await browser.close();
  }
}

async function expandReadableDisclosures(page: Page) {
  const disclosures = page.locator(
    'main button[aria-expanded="false"][aria-controls], article button[aria-expanded="false"][aria-controls], [role="main"] button[aria-expanded="false"][aria-controls]',
  );
  const count = Math.min(await disclosures.count(), 24);
  let expanded = false;
  for (let index = 0; index < count; index += 1) {
    const disclosure = disclosures.nth(index);
    const label = (await disclosure.textContent().catch(() => "")) || "";
    if (!isReadableDisclosureLabel(label)) continue;
    await disclosure.click({ timeout: 1_500 }).catch(() => undefined);
    expanded = true;
  }
  if (expanded) await page.waitForTimeout(150);
}

export function isReadableDisclosureLabel(value: string) {
  const label = cleanText(value).toLowerCase();
  return (
    label.length <= 240 &&
    /\b(?:show|read|expand|open|view)\b/.test(label) &&
    /\b(?:details?|case study|technical|analysis|implementation|more)\b/.test(
      label,
    ) &&
    !/\b(?:buy|checkout|delete|remove|submit|send|publish|sign in|log in)\b/.test(
      label,
    )
  );
}

function websitePathPriority(value: string) {
  try {
    const path = new URL(value).pathname.toLowerCase();
    let score = 0;
    if (/(?:work|project|case-study|portfolio|cv|resume|publication|certification|repository)/.test(path))
      score += 10;
    if (/(?:about|experience|research|writing|blog)/.test(path)) score += 4;
    if (/(?:privacy|terms|cookie|contact|login|signup)/.test(path)) score -= 10;
    score -= path.split("/").filter(Boolean).length;
    return score;
  } catch {
    return 0;
  }
}

async function fetchPublic(
  initialUrl: URL,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<{ url: URL; buffer: Buffer; contentType: string }> {
  let url = initialUrl;
  for (let redirect = 0; redirect < 4; redirect += 1) {
    signal?.throwIfAborted();
    await assertPublicHttpUrl(url);
    const timeout = AbortSignal.timeout(15_000);
    const requestSignal = signal
      ? AbortSignal.any([signal, timeout])
      : timeout;
    const response = await fetch(url, { headers: { "User-Agent": "Job-Apply-Go/0.1", ...headers }, redirect: "manual", signal: requestSignal });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) { url = new URL(response.headers.get("location")!, url); continue; }
    if (!response.ok) throw new Error(`Could not read ${url.hostname} (${response.status})`);
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_WEB_BYTES) throw new Error("Web source is larger than 3 MB");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_WEB_BYTES) throw new Error("Web source is larger than 3 MB");
    return { url, buffer, contentType: response.headers.get("content-type")?.split(";")[0] || "application/octet-stream" };
  }
  throw new Error("Too many redirects while reading the source");
}

function htmlToText(html: string, url?: URL): string {
  const $ = cheerio.load(html);
  const structuredData = $('script[type="application/ld+json"]')
    .map((_, element) => $(element).text())
    .get()
    .join("\n");
  const linkedPages = $("a[href]")
    .map((_, element) => {
      const label = $(element).text().trim();
      const href = $(element).attr("href");
      return label && href ? `${label}: ${href}` : "";
    })
    .get()
    .filter(Boolean)
    .join("\n");
  $("script,style,noscript,svg,nav,footer,form").remove();
  const title = $("title").first().text().trim();
  const description = $('meta[name="description"]').attr("content")?.trim();
  const main = $("main,article,[role=main]").first();
  const body = (main.length ? main : $("body")).text();
  return cleanText(
    [
      url ? `Source: ${url.href}` : "",
      title,
      description,
      structuredData,
      linkedPages,
      body,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

export function decodeBase64(value: string): Buffer {
  const normalized = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  const buffer = Buffer.from(normalized, "base64");
  if (!buffer.length || buffer.length > MAX_FILE_BYTES) throw new Error("Uploaded file is empty or larger than 15 MB");
  return buffer;
}

export async function readUploadedDocument(dataBase64: string, name: string) {
  const bytes = decodeBase64(dataBase64);
  return {
    bytes,
    text: await extractDocument(bytes, name),
  };
}

function ensureReadable(value: string, label: string): string {
  const text = cleanText(value);
  if (text.length < 20) throw new Error(`${label} contains no readable text. Scanned documents need OCR before upload.`);
  return ensureSupportedLength(text, label);
}

function cleanText(value: string): string {
  return value.replace(/\u0000/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
function ensureSupportedLength(value: string, label: string) {
  if (value.length > MAX_EXTRACTED_CHARS)
    throw new Error(
      `${label} contains more than ${MAX_EXTRACTED_CHARS.toLocaleString()} readable characters. Split it into smaller sources so every part can be analyzed.`,
    );
  return value;
}
function filenameFromUrl(url: URL) { return decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) || ""); }
function isHtml(contentType: string) { return contentType.includes("text/html") || contentType.includes("application/xhtml"); }
function isAssetPath(pathname: string) {
  return /\.(?:avif|css|csv|docx?|gif|ico|jpe?g|js|json|map|mp3|mp4|pdf|png|svg|txt|webm|webp|woff2?|xml|zip)$/i.test(pathname);
}
