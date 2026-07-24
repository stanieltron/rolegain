import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface StageRunArtifact<TKind extends string, TData> {
  artifactKind: TKind;
  schemaVersion: string;
  createdAt: string;
  producer: {
    programId: string;
    pipeline: string;
    stage: string;
  };
  dataRoot?: string;
  workspaceRef?: {
    candidateId: string;
    evidenceRunId?: string;
  };
  data: TData;
  diagnostics?: {
    codexRuns?: string[];
    warnings?: string[];
  };
}

export function createStageRunArtifact<TKind extends string, TData>(input: {
  artifactKind: TKind;
  schemaVersion?: string;
  producer: StageRunArtifact<TKind, TData>["producer"];
  data: TData;
  dataRoot?: string;
  workspaceRef?: StageRunArtifact<TKind, TData>["workspaceRef"];
  diagnostics?: StageRunArtifact<TKind, TData>["diagnostics"];
}): StageRunArtifact<TKind, TData> {
  return {
    artifactKind: input.artifactKind,
    schemaVersion: input.schemaVersion ?? "1.0.0",
    createdAt: new Date().toISOString(),
    producer: input.producer,
    dataRoot: input.dataRoot,
    workspaceRef: input.workspaceRef,
    data: input.data,
    diagnostics: input.diagnostics,
  };
}

export function assertStageRunArtifactKind<TKind extends string>(
  value: unknown,
  expectedKind: TKind,
): asserts value is StageRunArtifact<TKind, unknown> {
  if (!value || typeof value !== "object")
    throw new Error(`Expected ${expectedKind} artifact object`);
  const artifact = value as { artifactKind?: unknown; data?: unknown };
  if (artifact.artifactKind !== expectedKind)
    throw new Error(
      `Expected ${expectedKind} artifact, received ${String(
        artifact.artifactKind ?? "unknown",
      )}`,
    );
  if (!("data" in artifact))
    throw new Error(`Artifact ${expectedKind} has no data property`);
}

export async function readJsonArtifact<T = unknown>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.resolve(file), "utf8")) as T;
}

export async function writeJsonArtifact(file: string, value: unknown) {
  const target = path.resolve(file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return target;
}
