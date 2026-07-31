import type {
  CandidateContradiction,
  EvidenceClaim,
} from "../contracts/evidence.js";
import type {
  CandidateIntelligence,
  CandidateProfile,
} from "../contracts/job-search.js";

type EvidenceReview = NonNullable<CandidateIntelligence["evidenceReview"]>;

export function applyEvidenceReviews(
  claims: EvidenceClaim[],
  contradictions: CandidateContradiction[],
  profile: CandidateProfile,
  reviews: EvidenceReview = { claims: [], contradictions: [] },
) {
  const claimReviews = new Map(
    reviews.claims.map((review) => [review.claimId, review]),
  );
  const contradictionReviews = new Map(
    reviews.contradictions.map((review) => [review.contradictionId, review]),
  );
  return {
    claims: claims
      .map((claim) => ({ ...claim, review: claimReviews.get(claim.claimId) }))
      .filter((claim) => claim.review?.decision !== "remove"),
    contradictions: contradictions.filter((contradiction) => {
      const review = contradictionReviews.get(contradiction.contradictionId);
      if (review && review.decision !== "keep_unresolved") return false;
      return !contradictionResolvedByCurrentProfile(contradiction, profile);
    }),
  };
}

export function contradictionResolvedByCurrentProfile(
  contradiction: CandidateContradiction,
  profile: CandidateProfile,
) {
  const current = profileValue(profile, contradiction.field);
  if (!current) return false;
  const staleProfileValues = contradiction.values.filter(
    (item) => item.sourceId === "current-profile",
  );
  const sourceValues = contradiction.values.filter(
    (item) => item.sourceId !== "current-profile",
  );
  return (
    (staleProfileValues.some((item) => item.value !== current) &&
      sourceValues.some((item) => item.value === current)) ||
    (sourceValues.length > 0 &&
      staleProfileValues.some(
        (item) => item.value === current && isPlaceholderProfileValue(item.value),
      ))
  );
}

function profileValue(profile: CandidateProfile, field: string) {
  if (!PROFILE_REVIEW_FIELDS.has(field)) return "";
  const value = (profile as unknown as Record<string, string>)[field];
  return typeof value === "string" ? value : "";
}

function isPlaceholderProfileValue(value: string) {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "local user" ||
    normalized === "unknown" ||
    normalized === "candidate" ||
    normalized.endsWith("@rolegain.invalid")
  );
}

export const PROFILE_REVIEW_FIELDS = new Set([
  "name",
  "email",
  "phone",
  "linkedin",
  "github",
  "website",
  "location",
  "headline",
  "summary",
  "workAuthorization",
]);
