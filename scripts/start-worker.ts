import { loadEnvFile } from "node:process";
import { createRolegainDependencies } from "../src/backend/control-flow/composition.js";

try {
  loadEnvFile(".env");
} catch (error) {
  if (
    !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )
  )
    throw error;
}

process.env.ROLEGAIN_LLM_TRANSPORT ||= "api";
process.env.ROLEGAIN_PROCESS_JOBS = "true";

const dependencies = await createRolegainDependencies();
if (!dependencies.workflows)
  throw new Error(
    "The worker requires DATABASE_URL and ROLEGAIN_AUTH_MODE=supabase",
  );

console.log("Rolegain workflow worker is ready.");

const shutdown = async () => {
  await dependencies.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
await new Promise(() => undefined);
