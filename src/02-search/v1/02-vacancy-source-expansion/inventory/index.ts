import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LiveCandidate } from "../../../../search-match-shared/types.js";
import { normalizeOpportunityUrl } from "../../../../search-match-shared/opportunity.js";
import type { VacancySourceCheckpoint } from "../contracts.js";

export function vacancySourceId(url: string) {
  return `source-${createHash("sha256")
    .update(normalizeOpportunityUrl(url))
    .digest("hex")
    .slice(0, 20)}`;
}

export class VacancySourceInventory {
  constructor(
    private readonly dataRoot: string,
    private readonly candidateId: string,
  ) {}

  private get directory() {
    return path.join(
      this.dataRoot,
      "job-search",
      "candidates",
      this.candidateId,
      "vacancy-sources",
    );
  }

  async list(): Promise<VacancySourceCheckpoint[]> {
    try {
      const files = (await readdir(this.directory))
        .filter((file) => file.endsWith(".json"))
        .sort();
      return await Promise.all(
        files.map(async (file) =>
          JSON.parse(
            await readFile(path.join(this.directory, file), "utf8"),
          ) as VacancySourceCheckpoint,
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async load(sourceId: string): Promise<VacancySourceCheckpoint | undefined> {
    try {
      return JSON.parse(
        await readFile(path.join(this.directory, `${sourceId}.json`), "utf8"),
      ) as VacancySourceCheckpoint;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async register(candidate: LiveCandidate): Promise<VacancySourceCheckpoint> {
    const sourceId = vacancySourceId(candidate.job.jobUrl);
    const existing = await this.load(sourceId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const checkpoint: VacancySourceCheckpoint = {
      version: 1,
      sourceId,
      candidateId: this.candidateId,
      sourceUrl: candidate.job.jobUrl,
      sourceName: candidate.company || candidate.job.title || candidate.job.jobUrl,
      sourceClass: candidate.job.sourceClass || "employer_directory",
      discoveryQuery: candidate.job.discoveryQuery || "saved vacancy source",
      cursorUrl: candidate.job.jobUrl,
      hasMore: true,
      pagesInspected: 0,
      vacanciesInspected: 0,
      vacanciesEmitted: 0,
      seenVacancyUrls: [],
      pendingVacancies: [],
      firstSeenAt: now,
      lastSynchronizedAt: "",
      lastHeadRefreshAt: "",
    };
    await this.save(checkpoint);
    return checkpoint;
  }

  async save(checkpoint: VacancySourceCheckpoint) {
    checkpoint.pendingVacancies ??= [];
    await mkdir(this.directory, { recursive: true });
    await writeFile(
      path.join(this.directory, `${checkpoint.sourceId}.json`),
      JSON.stringify(checkpoint, null, 2),
      "utf8",
    );
  }

  async clear() {
    await rm(this.directory, { recursive: true, force: true });
  }
}

export function checkpointAsCandidate(
  checkpoint: VacancySourceCheckpoint,
): LiveCandidate {
  return {
    company: checkpoint.sourceName,
    preliminaryFit: 0,
    job: {
      id: checkpoint.sourceId,
      title: checkpoint.sourceName,
      jobUrl: checkpoint.sourceUrl,
      applyUrl: checkpoint.sourceUrl,
      sourceKind: "job_list",
      sourceClass: checkpoint.sourceClass,
      discoveryQuery: checkpoint.discoveryQuery,
      isListed: true,
    },
  };
}

export function checkpointNeedsHeadRefresh(
  checkpoint: VacancySourceCheckpoint,
  now = Date.now(),
) {
  const refreshed = Date.parse(checkpoint.lastHeadRefreshAt || "");
  const ttl = Math.max(
    60 * 60_000,
    Number(process.env.ROLEGAIN_SOURCE_REFRESH_TTL_MS || 24 * 60 * 60_000),
  );
  return !Number.isFinite(refreshed) || now - refreshed >= ttl;
}
