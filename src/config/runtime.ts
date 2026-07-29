export type AuthMode = "local" | "supabase";

export interface RuntimeConfiguration {
  authMode: AuthMode;
  databaseUrl?: string;
  publicOrigin?: string;
  processJobs: boolean;
  objectStorageEnabled: boolean;
  supabaseUrl?: string;
  supabasePublishableKey?: string;
  supabaseServiceRoleKey?: string;
  supabaseStorageBucket: string;
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

  if (authMode === "supabase") {
    required("DATABASE_URL", environment.DATABASE_URL);
    required("SUPABASE_URL", supabaseUrl);
    required("SUPABASE_PUBLISHABLE_KEY", supabasePublishableKey);
    required("SUPABASE_SERVICE_ROLE_KEY", supabaseServiceRoleKey);
  }

  return {
    authMode,
    databaseUrl: clean(environment.DATABASE_URL),
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
  };
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
