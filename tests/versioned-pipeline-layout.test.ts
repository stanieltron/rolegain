import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as evidenceV1Schemas from "../src/01-evidence-ingestion/v1/schemas.js";
import * as evidenceV2Schemas from "../src/01-evidence-ingestion/v2/schemas.js";
import * as searchV1Schemas from "../src/02-search/v1/schemas.js";
import * as searchV2Schemas from "../src/02-search/v2/schemas.js";
import * as matchV1Schemas from "../src/03-match/v1/schemas.js";
import * as matchV2Schemas from "../src/03-match/v2/schemas.js";

const versionPackages = [
  "src/01-evidence-ingestion/v1",
  "src/01-evidence-ingestion/v2",
  "src/02-search/v1",
  "src/02-search/v2",
  "src/03-match/v1",
  "src/03-match/v2",
] as const;

describe("versioned pipeline packages", () => {
  it("gives every production version the same public package surface", async () => {
    for (const root of versionPackages) {
      for (const file of ["index.ts", "contracts.ts", "schemas.ts", "README.md"])
        await expect(access(path.resolve(root, file))).resolves.toBeUndefined();
      const readme = await readFile(path.resolve(root, "README.md"), "utf8");
      for (const file of ["index.ts", "contracts.ts", "schemas.ts", "README.md"])
        expect(readme, `${root}/${file}`).toContain(file);
    }
  });

  it("exports concrete schemas from every version", () => {
    for (const schemas of [
      evidenceV1Schemas,
      evidenceV2Schemas,
      searchV1Schemas,
      searchV2Schemas,
      matchV1Schemas,
      matchV2Schemas,
    ]) {
      expect(Object.keys(schemas).length).toBeGreaterThan(0);
      for (const schema of Object.values(schemas))
        expect(schema).toMatchObject({ type: "object" });
    }
  });

  it("documents a version-specific eval target for every pipeline", async () => {
    for (const root of [
      "evals/evidence-ingestion",
      "evals/search",
      "evals/match-requirements",
    ]) {
      await expect(access(path.resolve(root, "v1", "README.md"))).resolves.toBeUndefined();
      await expect(access(path.resolve(root, "v2", "README.md"))).resolves.toBeUndefined();
    }
    const packageJson = JSON.parse(
      await readFile(path.resolve("package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    for (const script of [
      "eval:evidence:v1",
      "eval:evidence:v2",
      "eval:match-requirements:v1",
      "eval:match-requirements:v2",
    ]) expect(packageJson.scripts[script], script).toBeTruthy();
  });
});
