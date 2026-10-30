export const PIPELINE_STEPS = [
  {
    id: 1,
    key: "scraper",
    title: "Job Spec Scraper",
    blurb: "Collect the full job description text.",
  },
  {
    id: 2,
    key: "intent",
    title: "Intent & Analysis",
    blurb: "Describe what the job is actually looking for in the candidate.",
  },
  {
    id: 3,
    key: "keywords",
    title: "Keyword & Phrase Extraction",
    blurb: "Extract the keywords and phrases needed for the resume.",
  },
  {
    id: 4,
    key: "resume-analysis",
    title: "Resume Analysis",
    blurb: "Extract all information from the existing resume.",
  },
  {
    id: 5,
    key: "score-original",
    title: "Score Original",
    blurb: "Score the submitted resume on the five ATS and reviewer measures, with facts and suggestions.",
  },
  {
    id: 6,
    key: "full-rewrite",
    title: "Full Rewrite",
    blurb: "Rewrite the whole resume from the job, intent, keywords, resume facts and score suggestions.",
  },
  {
    id: 7,
    key: "bold-check",
    title: "Bold Rule Check & Fix",
    blurb: "Code check of the dual-anchor bold rule; failing lines go back to the model (max 2 loops).",
  },
  {
    id: 8,
    key: "score-rewrite",
    title: "Score Rewrite",
    blurb: "Score the rewrite on the same five measures and list what is still missing.",
  },
  {
    id: 9,
    key: "final",
    title: "Final HTML",
    blurb: "Deliver the copy-ready resume HTML.",
  },
] as const;

export type StepId = (typeof PIPELINE_STEPS)[number]["id"];
export type StepStatus = "idle" | "running" | "done" | "error";

export type KeywordSet = {
  keywords: string[];
  phrases: string[];
  must_have: string[];
  nice_to_have: string[];
  hard_skills?: string[];
  soft_skills?: string[];
  rubric?: Record<string, number>;
};

export type AuditFlag = {
  issue: string;
  fix: string;
};

export type AuditResult = {
  flags: AuditFlag[];
  keyword_counts: Record<string, number>;
  match_percentage?: number;
  skill_gaps?: string[];
  /** Scores of the submitted resume (step 5). */
  before?: ScoreReport;
  /** Scores of the rewrite (step 8). */
  after?: ScoreReport;
  /** Result of the code-only bold check after the fix loops (step 7). */
  bold?: { checked: number; passed: number; loops: number; failures: BoldFailure[] };
  /** Code-only fact check: numbers or headings in the rewrite that are not in the original. */
  fact_flags?: AuditFlag[];
};

/* ───── Scoring ───── */

export const SCORE_KEYS = [
  "ats_engine_readiness",
  "job_fit",
  "ai_written_likelihood",
  "ats_pass_to_human_chance",
  "human_scannability",
] as const;
export type ScoreKey = (typeof SCORE_KEYS)[number];

export const SCORE_LABELS: Record<ScoreKey, string> = {
  ats_engine_readiness: "ATS engine readiness",
  job_fit: "Fit to the job description",
  ai_written_likelihood: "How heavily AI-written (higher = more AI-like)",
  ats_pass_to_human_chance: "Chance of passing the ATS into human review",
  human_scannability: "Human scannability",
};

/** One score: 0.0–10.0, one decimal, with the facts that prove it and every suggestion. */
export type ScoreItem = { score: number; facts: string[]; suggestions: string[] };

export type ScoreReport = Record<ScoreKey, ScoreItem> & {
  fabrication_flags: AuditFlag[];
};

/** One summary/bullet/competency line that fails the dual-anchor bold rule. */
export type BoldFailure = { index: number; section: string; text: string; problems: string[] };

/**
 * Run memory. Created at the start of a run and kept in the browser. Each
 * step adds its result; each server call gets only the fields it needs.
 */
export type RunMemory = {
  original_html: string;
  job_url: string;
  job_text: string;
  intent: string;
  priorities: string[];
  keywords: KeywordSet | null;
  resume_facts: unknown;
  before: ScoreReport | null;
  draft_html: string | null;
  final_html: string | null;
  after: ScoreReport | null;
  bold: AuditResult["bold"] | null;
  fact_flags: AuditFlag[];
};

export const API_KEY_STORAGE = "ats-align.gemini-api-key";
export const SEARCH_API_KEY_STORAGE = "ats-align.search-api-key";
export const DRAFT_STORAGE = "ats-align.draft";

export const MAX_RESUME_CHARS = 80_000;
export const MAX_JOB_CHARS = 40_000;
