import type { JobOpportunity, JobSearchWorkspace } from "../contracts/job-search.js";
import type {
  CandidateUnknown,
  CandidateContradiction,
  Capability,
  EvidenceClaim,
  RoleFamily,
} from "../contracts/evidence.js";
import { authorizationHeader } from "./auth.js";

export interface CanonicalEvidenceModel {
  claims: EvidenceClaim[];
  capabilities: Capability[];
  roleFamilies: RoleFamily[];
  unknowns: CandidateUnknown[];
  contradictions: CandidateContradiction[];
}

export interface BetaStatus {
  applicationsUsed: number;
  applicationLimit: number;
  batchesStarted: number;
  batchLimit: number;
  remainingApplications: number;
  remainingBatches: number;
  canStartBatch: boolean;
  releaseUpdates: boolean;
}

export interface ServiceStatus {
  codexEnabled: boolean;
  maintenanceMessage?: string;
}

export const getWorkspace = () =>
  get<JobSearchWorkspace>("/api/job-search").then(normalizeWorkspace);
export const getCanonicalEvidence = (candidateId: string) =>
  get<CanonicalEvidenceModel>(
    `/api/job-search/candidates/${encodeURIComponent(candidateId)}/evidence`,
  );
export const reviewEvidenceClaim = (
  claimId: string,
  decision: "candidate_confirmed" | "keep_weak" | "remove",
  note?: string,
) =>
  workspacePost(
    `/api/job-search/evidence-review/claims/${encodeURIComponent(claimId)}`,
    { decision, note },
  );
export const reviewEvidenceContradiction = (
  contradictionId: string,
  decision: "use_value" | "both_valid" | "keep_unresolved",
  selectedValue?: string,
) =>
  workspacePost(
    `/api/job-search/evidence-review/contradictions/${encodeURIComponent(contradictionId)}`,
    { decision, selectedValue },
  );
export const getBetaStatus = () => get<BetaStatus>("/api/beta");
export const getServiceStatus = () =>
  get<ServiceStatus>("/api/service-status");
export const enableReleaseUpdates = () =>
  post<BetaStatus>("/api/beta/release-updates", {});
export const trackAnalyticsEvent = (
  name:
    | "view_profile"
    | "view_discovery"
    | "view_applications"
    | "job_source_opened"
    | "application_opened"
    | "employer_form_opened",
  metadata: Record<string, string | number | boolean | null> = {},
) =>
  post<{ recorded: boolean }>("/api/analytics/events", { name, metadata })
    .catch(() => undefined);
export const updateCandidateProfile = (body: {
  name: string;
  email: string;
  phone: string;
  linkedin: string;
  github: string;
  website: string;
  location?: string;
  workAuthorization: string;
  deferEvidenceAnalysis?: boolean;
}) => workspacePost("/api/job-search/profile", body);
export const exploreProfileEvidence = (field: "github" | "website") =>
  workspacePost("/api/job-search/profile-evidence/explore", { field });
export const stopBackgroundWork = () =>
  workspacePost("/api/job-search/background/stop", {});
export const continueBackgroundWork = () =>
  workspacePost("/api/job-search/background/continue", {});
export const resetJobList = () =>
  workspacePost("/api/job-search/reset-jobs", {});
export const resetUser = () =>
  workspacePost("/api/job-search/reset-user", {});
export const addSource = (body: {
  kind: string;
  name: string;
  content?: string;
  dataBase64?: string;
  mimeType?: string;
  url?: string;
  deferAnalysis?: boolean;
  includeGitHubContributions?: boolean;
}) => workspacePost("/api/job-search/sources", body);
export const removeSource = (id: string) =>
  workspaceDelete(`/api/job-search/sources/${encodeURIComponent(id)}`);
export const analyzeCandidate = () =>
  workspacePost("/api/job-search/analyze", {});
export const answerQuestion = (id: string, answer: string) =>
  workspacePost(`/api/job-search/questions/${id}`, { answer });
export const finishIntake = () =>
  workspacePost("/api/job-search/finish-intake", {});
export const prepareApplications = () =>
  workspacePost("/api/job-search/prepare", {});
export const prepareSearchReadyApplications = () =>
  workspacePost("/api/job-search/prepare-ready", {});
export const findMoreApplications = () =>
  workspacePost("/api/job-search/find-more", {});
export const updateSearchConfig = (body: {
  discoveryTarget: number;
  applicationTarget: number;
}) => workspacePost("/api/job-search/search-config", body);
export const addOpportunity = (
  body: Pick<JobOpportunity, "company" | "title" | "applyUrl"> &
    Partial<JobOpportunity>,
) => workspacePost("/api/job-search/opportunities", body);
export const promoteOpportunity = (id: string) =>
  workspacePost(
    `/api/job-search/opportunities/${encodeURIComponent(id)}/promote`,
    {},
  );
export const updateApplication = (
  id: string,
  body: { coverLetter?: string; fields?: Record<string, string> },
) => workspacePost(`/api/job-search/applications/${id}`, body);
export const refineCoverLetter = (id: string, message: string) =>
  workspacePost(`/api/job-search/applications/${id}/cover-letter-chat`, {
    message,
  });
export const tailorApplicationCv = (id: string) =>
  workspacePost(`/api/job-search/applications/${id}/tailored-cv`, {});
export async function downloadTailoredCv(id: string, fileName: string) {
  const response = await fetch(
    `/api/job-search/applications/${encodeURIComponent(id)}/tailored-cv`,
    { headers: await authorizationHeader() },
  );
  if (!response.ok) throw new Error(await error(response));
  const objectUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}
export const refineApplicationField = (
  id: string,
  fieldId: string,
  message: string,
) =>
  workspacePost(
    `/api/job-search/applications/${id}/fields/${encodeURIComponent(fieldId)}/refine`,
    { message },
  );
export const setApplicationOutcome = (
  id: string,
  outcome?: "rejected_by_user" | "unsuccessful" | "applied_waiting",
) =>
  workspacePost(`/api/job-search/applications/${id}/outcome`, {
    outcome: outcome ?? null,
  });
async function get<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: await authorizationHeader(),
  });
  if (!response.ok) throw new Error(await error(response));
  return response.json() as Promise<T>;
}
async function post<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authorizationHeader()),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await error(response));
  return response.json() as Promise<T>;
}
async function del<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    method: "DELETE",
    headers: await authorizationHeader(),
  });
  if (!response.ok) throw new Error(await error(response));
  return response.json() as Promise<T>;
}
async function error(response: Response) {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `Request failed (${response.status})`;
}
const workspacePost = (url: string, body: unknown) =>
  post<JobSearchWorkspace>(url, body).then(normalizeWorkspace);
const workspaceDelete = (url: string) =>
  del<JobSearchWorkspace>(url).then(normalizeWorkspace);
function normalizeWorkspace(workspace: JobSearchWorkspace): JobSearchWorkspace {
  workspace.sources = (workspace.sources ?? []).map((source) => ({
    ...source,
    insights: source.insights ?? [],
    status: source.status ?? "ready",
  }));
  workspace.intelligence ??= { status: "idle" };
  workspace.intelligence.evidenceReview ??= {
    claims: [],
    contradictions: [],
  };
  workspace.discoveryNeedsRun ??=
    !workspace.searchProgress && (workspace.jobHistory?.length ?? 0) === 0;
  workspace.rejectedOpportunities ??= [];
  workspace.searchValidationIssues ??= [];
  workspace.searchReadyOpportunities ??= [];
  workspace.seenJobUrls ??= [];
  workspace.searchConfig ??= { discoveryTarget: 26, applicationTarget: 5 };
  workspace.applications = (workspace.applications ?? []).map(
    (application) => ({
      ...application,
      coverLetterChat: application.coverLetterChat ?? [],
    }),
  );
  workspace.opportunities = (workspace.opportunities ?? []).map(
    (opportunity) => ({
      ...opportunity,
      requirements: opportunity.requirements ?? [],
      requirementMatches: opportunity.requirementMatches ?? [],
      strengths: opportunity.strengths ?? [],
      gaps: opportunity.gaps ?? [],
    }),
  );
  return workspace;
}
