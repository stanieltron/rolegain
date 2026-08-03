export type AuthMode = "local" | "supabase";
export type SearchVersion = "v1" | "v2";
export type EvidenceIngestionVersion = "v1" | "v2";
export type MatchVersion = "v1" | "v2";

export interface RuntimeConfiguration {
  authMode: AuthMode;
  searchVersion: SearchVersion;
  evidenceIngestionVersion: EvidenceIngestionVersion;
  matchVersion: MatchVersion;
  databaseUrl?: string;
  applicationDatabaseUrl?: string;
  publicOrigin?: string;
  processJobs: boolean;
  objectStorageEnabled: boolean;
  supabaseUrl?: string;
  supabasePublishableKey?: string;
  supabaseServiceRoleKey?: string;
  supabaseStorageBucket: string;
  adminUsername?: string;
  adminPassword?: string;
  adminSessionSecret?: string;
}

export function runtimeConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeConfiguration {
  const authMode = environment.ROLEGAIN_AUTH_MODE === "supabase"
    ? "supabase"
    : "local";
  const supabaseUrl = clean(environment.SUPABASE_URL);
  const supabasePublishableKey = clean(
    environment.SUPABASE_PUBLISHABLE_KEY ||
      environment.SUPABASE_ANON_KEY,
  );
  const supabaseServiceRoleKey = clean(
    environment.SUPABASE_SERVICE_ROLE_KEY,
  );
  const databaseUrl = clean(environment.DATABASE_URL);
  const applicationDatabaseUrl =
    clean(environment.ROLEGAIN_TRANSACTION_DATABASE_URL) ||
    transactionPoolConnectionString(databaseUrl);

  if (authMode === "supabase") {
    required("DATABASE_URL", environment.DATABASE_URL);
    required("SUPABASE_URL", supabaseUrl);
    required("SUPABASE_PUBLISHABLE_KEY", supabasePublishableKey);
    required("SUPABASE_SERVICE_ROLE_KEY", supabaseServiceRoleKey);
  }

  return {
    authMode,
    searchVersion: environment.ROLEGAIN_SEARCH_VERSION === "v2" ? "v2" : "v1",
    evidenceIngestionVersion:
      environment.ROLEGAIN_EVIDENCE_VERSION === "v2" ? "v2" : "v1",
    matchVersion:
      environment.ROLEGAIN_MATCH_VERSION === "v2" ? "v2" : "v1",
    databaseUrl,
    applicationDatabaseUrl,
    publicOrigin: clean(environment.ROLEGAIN_PUBLIC_ORIGIN),
    processJobs: environment.ROLEGAIN_PROCESS_JOBS !== "false",
    objectStorageEnabled:
      authMode === "supabase" &&
      environment.ROLEGAIN_OBJECT_STORAGE !== "disabled",
    supabaseUrl,
    supabasePublishableKey,
    supabaseServiceRoleKey,
    supabaseStorageBucket:
      clean(environment.SUPABASE_STORAGE_BUCKET) || "rolegain-private",
    adminUsername: clean(environment.ROLEGAIN_ADMIN_USERNAME),
    adminPassword: clean(environment.ROLEGAIN_ADMIN_PASSWORD),
    adminSessionSecret: clean(environment.ROLEGAIN_ADMIN_SESSION_SECRET),
  };
}

export function transactionPoolConnectionString(
  connectionString: string | undefined,
) {
  if (!connectionString) return undefined;
  try {
    const url = new URL(connectionString);
    if (
      url.port === "5432" &&
      /(^|\.)pooler\.supabase\.com$/i.test(url.hostname)
    ) {
      url.port = "6543";
      return url.toString();
    }
  } catch {
    // Preserve non-URL libpq connection strings and let node-postgres parse them.
  }
  return connectionString;
}

function clean(value: string | undefined) {
  return value?.trim() || undefined;
}

function required(name: string, value: string | undefined) {
  if (!clean(value))
    throw new Error(
      `${name} is required when ROLEGAIN_AUTH_MODE=supabase`,
    );
}
