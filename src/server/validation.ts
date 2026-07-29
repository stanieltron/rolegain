import { z, type ZodType } from "zod";
import { HttpError } from "./auth.js";

const optionalText = (maximum: number) =>
  z.string().trim().max(maximum).optional();
const optionalUrl = z
  .union([z.literal(""), z.string().url().max(2_000)])
  .optional();

export const profileSchema = z.object({
  name: optionalText(200),
  email: z.union([z.literal(""), z.string().email().max(320)]).optional(),
  phone: optionalText(100),
  linkedin: optionalUrl,
  github: optionalUrl,
  website: optionalUrl,
  location: optionalText(300),
  workAuthorization: optionalText(2_000),
  deferEvidenceAnalysis: z.boolean().optional(),
});

export const sourceSchema = z
  .object({
    kind: z.enum([
      "cv",
      "document",
      "github",
      "portfolio",
      "repository",
      "webpage",
    ]),
    name: z.string().trim().min(1).max(300),
    content: z.string().max(5_000_000).optional(),
    dataBase64: z.string().max(30_000_000).optional(),
    mimeType: optionalText(200),
    url: optionalUrl,
    deferAnalysis: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.content !== undefined ||
      value.dataBase64 !== undefined ||
      value.url !== undefined,
    "A source needs content, file data, or a URL",
  );

export const searchConfigSchema = z.object({
  discoveryTarget: z.coerce.number().int().min(5).max(50),
  applicationTarget: z.coerce.number().int().min(1).max(10),
});

export const opportunitySchema = z.object({
  company: z.string().trim().min(1).max(300),
  title: z.string().trim().min(1).max(300),
  applyUrl: z.string().url().max(2_000),
  sourceUrl: z.string().url().max(2_000).optional(),
  location: optionalText(300),
  workplace: optionalText(100),
  compensation: optionalText(300),
  summary: optionalText(10_000),
});

export const applicationUpdateSchema = z.object({
  coverLetter: z.string().max(100_000).optional(),
  fields: z.record(z.string(), z.string().max(100_000)).optional(),
});

export const messageSchema = z.object({
  message: z.string().trim().min(1).max(10_000),
});

export const answerSchema = z.object({
  answer: z.string().max(100_000),
});

export const outcomeSchema = z.object({
  outcome: z
    .enum(["rejected_by_user", "unsuccessful", "applied_waiting"])
    .nullable()
    .optional(),
});

export function validate<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new HttpError(
    400,
    result.error.issues[0]?.message || "Invalid request",
    "invalid_request",
  );
}
