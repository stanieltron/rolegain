import type { CandidateProfile, FormField } from "../contracts/job-search.js";

export const REUSABLE_CANDIDATE_KEYS = new Set([
  "name",
  "email",
  "phone",
  "linkedin",
  "github",
  "website",
  "current_location",
  "intended_work_location",
  "country",
  "work_region",
  "work_authorization",
  "start_date",
  "eeoc_gender",
  "eeoc_race",
  "eeoc_veteran_status",
  "eeoc_disability_status",
]);

export function reusableCandidateKey(
  field: Pick<FormField, "canonicalKey" | "label">,
): string | undefined {
  const value = `${field.canonicalKey || ""} ${field.label}`.toLowerCase();
  if (/legal name|full name|\bname\b/.test(value)) return "name";
  if (/email/.test(value)) return "email";
  if (/phone|mobile/.test(value)) return "phone";
  if (/linkedin/.test(value)) return "linkedin";
  if (/github/.test(value)) return "github";
  if (/portfolio|website|personal site/.test(value)) return "website";
  if (
    /anticipated work location|city.*country.*intend|which country.*work from|country.*intend.*work/.test(
      value,
    )
  )
    return "intended_work_location";
  if (/current[_ ]location|currently live|where.*located|home address/.test(value))
    return "current_location";
  if (/work[_ ]region|north america.*south america.*europe/.test(value))
    return "work_region";
  if (/work[_ ]authorization|authori[sz]ed to work/.test(value))
    return "work_authorization";
  if (/when.*start|start date|available from/.test(value)) return "start_date";
  if (/eeoc_gender|\bgender\b/.test(value)) return "eeoc_gender";
  if (/eeoc_race|race|ethnicity/.test(value)) return "eeoc_race";
  if (/eeoc_veteran|veteran/.test(value)) return "eeoc_veteran_status";
  if (/eeoc_disability|disability/.test(value))
    return "eeoc_disability_status";
  if (/\bcountry\b/.test(value)) return "country";
  return undefined;
}

export function compatibleCandidateValue(field: FormField, value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (!field.options?.length) return trimmed;
  return (
    field.options.find(
      (option) => normalizeCandidateChoice(option) === normalizeCandidateChoice(trimmed),
    ) || ""
  );
}

export function syncProfileFact(
  profile: CandidateProfile,
  key: string,
  value: string,
) {
  const trimmed = value.trim();
  if (key === "name") profile.name = trimmed;
  else if (key === "email") profile.email = trimmed;
  else if (key === "phone") profile.phone = trimmed;
  else if (key === "linkedin") profile.linkedin = trimmed;
  else if (key === "github") profile.github = trimmed;
  else if (key === "website") profile.website = trimmed;
  else if (key === "current_location") profile.location = trimmed;
  else if (key === "work_authorization") profile.workAuthorization = trimmed;
  else if (key === "start_date") profile.startDate = trimmed;
}

export function normalizeCandidateChoice(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
