import { loadEnvFile } from "node:process";
import { createDatabasePool, migrateDatabase } from "../src/infrastructure/database.js";

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

if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL is required");
const pool = createDatabasePool(process.env.DATABASE_URL);
try {
  await migrateDatabase(pool);
  console.log("Rolegain database migration completed.");
} finally {
  await pool.end();
}
