/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ROLEGAIN_AUTH_MODE?: "local" | "supabase";
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
