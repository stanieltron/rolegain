import type { SourceChunkNotes } from "../01-chunk-analysis/output.js";
import { outputSchema as sourceChunkNotesSchema } from "../01-chunk-analysis/output.js";

export type ChunkRepairRemovalTarget =
  | "profileFact"
  | "profileEvidence"
  | "insight"
  | "claim"
  | "unknown"
  | "prohibitedInference";

export interface ChunkRepairPatch {
  additions: SourceChunkNotes;
  removals: Array<{
    target: ChunkRepairRemovalTarget;
    match: string;
    findingId: string;
    reason: string;
  }>;
  resolutions: Array<{
    findingId: string;
    status: "applied" | "not_applicable";
    reason: string;
  }>;
}

const string = { type: "string" };

export const outputSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["additions", "removals", "resolutions"],
  properties: {
    additions: sourceChunkNotesSchema,
    removals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["target", "match", "findingId", "reason"],
        properties: {
          target: {
            type: "string",
            enum: [
              "profileFact",
              "profileEvidence",
              "insight",
              "claim",
              "unknown",
              "prohibitedInference",
            ],
          },
          match: string,
          findingId: string,
          reason: string,
        },
      },
    },
    resolutions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["findingId", "status", "reason"],
        properties: {
          findingId: string,
          status: { type: "string", enum: ["applied", "not_applicable"] },
          reason: string,
        },
      },
    },
  },
};

export const outputDescription =
  "A typed evidence delta with additions, exact-match removals, and a reasoned resolution for every coverage finding.";
