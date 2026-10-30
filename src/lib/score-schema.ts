import { z } from "zod";
import { SCORE_KEYS, type ScoreReport } from "@/lib/pipeline-types";

/** 0–10, exactly one decimal. Out-of-range values are clamped, not rejected. */
export function round1(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const clamped = Math.min(10, Math.max(0, n));
  return Math.round(clamped * 10) / 10;
}

const textList = z
  .array(z.unknown())
  .default([])
  .transform((list) => list.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean));

export const scoreItemSchema = z.object({
  score: z.coerce.number().refine(Number.isFinite, "score must be a number").transform(round1),
  facts: textList,
  suggestions: textList,
});

export const scoreReportSchema = z.object({
  ats_engine_readiness: scoreItemSchema,
  job_fit: scoreItemSchema,
  ai_written_likelihood: scoreItemSchema,
  ats_pass_to_human_chance: scoreItemSchema,
  human_scannability: scoreItemSchema,
  fabrication_flags: z
    .array(z.object({ issue: z.string(), fix: z.string().default("") }))
    .default([]),
});

export function parseScoreReport(raw: unknown): ScoreReport {
  return scoreReportSchema.parse(raw) as ScoreReport;
}

/** Gemini structured-output schema (generationConfig.responseSchema, OpenAPI subset). */
const geminiScoreItem = {
  type: "OBJECT",
  properties: {
    score: { type: "NUMBER", description: "0.0 to 10.0, one decimal place" },
    facts: { type: "ARRAY", items: { type: "STRING" } },
    suggestions: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["score", "facts", "suggestions"],
  propertyOrdering: ["score", "facts", "suggestions"],
};

export const GEMINI_SCORE_SCHEMA: Record<string, unknown> = {
  type: "OBJECT",
  properties: {
    ...Object.fromEntries(SCORE_KEYS.map((k) => [k, geminiScoreItem])),
    fabrication_flags: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { issue: { type: "STRING" }, fix: { type: "STRING" } },
        required: ["issue", "fix"],
      },
    },
  },
  required: [...SCORE_KEYS, "fabrication_flags"],
  propertyOrdering: [...SCORE_KEYS, "fabrication_flags"],
};

export const fixBlocksSchema = z.object({
  blocks: z.array(z.object({ index: z.coerce.number().int().min(0), html: z.string().min(1) })),
});

export const GEMINI_FIX_BLOCKS_SCHEMA: Record<string, unknown> = {
  type: "OBJECT",
  properties: {
    blocks: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { index: { type: "INTEGER" }, html: { type: "STRING" } },
        required: ["index", "html"],
      },
    },
  },
  required: ["blocks"],
};
