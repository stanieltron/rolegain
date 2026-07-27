import { loadEnvFile } from "node:process";

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

process.env.ROLEGAIN_LLM_TRANSPORT = "api";
await import("../src/server/index.js");
