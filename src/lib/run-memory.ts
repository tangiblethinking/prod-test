import {
  SCORE_KEYS,
  SCORE_LABELS,
  type AuditResult,
  type KeywordSet,
  type RunMemory,
  type ScoreReport,
} from "@/lib/pipeline-types";

/**
 * Run memory helpers. Pure functions: no network, no React. The memory object
 * lives in the browser for one run; each server call gets a compact slice.
 */

export function createRunMemory(input: { originalHtml: string; jobUrl: string; jobText: string }): RunMemory {
  return {
    original_html: input.originalHtml,
    job_url: input.jobUrl,
    job_text: input.jobText,
    intent: "",
    priorities: [],
    keywords: null,
    resume_facts: null,
    before: null,
    draft_html: null,
    final_html: null,
    after: null,
    bold: null,
    fact_flags: [],
  };
}

const MAX_FACTS_CHARS = 24_000;
const MAX_LIST = 60;

function compactKeywords(k: KeywordSet | null): KeywordSet {
  const take = (v?: string[]) => (v ?? []).slice(0, MAX_LIST);
  return {
    must_have: take(k?.must_have),
    nice_to_have: take(k?.nice_to_have),
    keywords: take(k?.keywords),
    phrases: take(k?.phrases),
  };
}

/** Resume facts as compact JSON text, capped so the request stays small. */
export function compactFacts(facts: unknown): string {
  if (facts == null) return "";
  let text: string;
  try {
    text = typeof facts === "string" ? facts : JSON.stringify(facts);
  } catch {
    return "";
  }
  return text.length > MAX_FACTS_CHARS ? text.slice(0, MAX_FACTS_CHARS) : text;
}

/** Every suggestion of a report, prefixed with its category. */
export function collectSuggestions(report: ScoreReport | null): string[] {
  if (!report) return [];
  const out: string[] = [];
  for (const key of SCORE_KEYS) {
    for (const s of report[key].suggestions) out.push(`[${SCORE_LABELS[key]}] ${s}`);
  }
  for (const f of report.fabrication_flags) out.push(`[Fact check] ${f.issue}${f.fix ? ` Fix: ${f.fix}` : ""}`);
  return out;
}

/** Scores plus facts only (no suggestions), for the rewrite prompt. */
export function scoreSummary(report: ScoreReport | null): Record<string, { score: number; facts: string[] }> {
  if (!report) return {};
  return Object.fromEntries(SCORE_KEYS.map((k) => [k, { score: report[k].score, facts: report[k].facts }]));
}

export type ScoreSlice = {
  jobText: string;
  intent: string;
  priorities: string[];
  keywords: KeywordSet;
  documentHtml: string;
  originalHtml?: string;
};

/** Step 5 (before) and step 8 (after). After also sends the original for the fabrication check. */
export function scoreSlice(mem: RunMemory, which: "before" | "after"): ScoreSlice {
  const doc = which === "before" ? mem.original_html : (mem.final_html ?? mem.draft_html ?? "");
  return {
    jobText: mem.job_text,
    intent: mem.intent,
    priorities: mem.priorities.slice(0, 30),
    keywords: compactKeywords(mem.keywords),
    documentHtml: doc,
    ...(which === "after" ? { originalHtml: mem.original_html } : {}),
  };
}

export type RewriteSlice = {
  originalHtml: string;
  jobText: string;
  intent: string;
  priorities: string[];
  keywords: KeywordSet;
  resumeFacts: string;
  beforeScores: Record<string, { score: number; facts: string[] }>;
  suggestions: string[];
};

/** Step 6: everything in memory, compacted. */
export function rewriteSlice(mem: RunMemory): RewriteSlice {
  return {
    originalHtml: mem.original_html,
    jobText: mem.job_text,
    intent: mem.intent,
    priorities: mem.priorities.slice(0, 30),
    keywords: compactKeywords(mem.keywords),
    resumeFacts: compactFacts(mem.resume_facts),
    beforeScores: scoreSummary(mem.before),
    suggestions: collectSuggestions(mem.before).slice(0, 200),
  };
}

/** The object the output panel reads. */
export function memoryToAudit(mem: RunMemory): AuditResult {
  return {
    flags: [...(mem.after?.fabrication_flags ?? []), ...mem.fact_flags],
    keyword_counts: {},
    before: mem.before ?? undefined,
    after: mem.after ?? undefined,
    bold: mem.bold ?? undefined,
    fact_flags: mem.fact_flags,
  };
}

/** Plain-text version of the report (used for tests and for "copy report"). */
export function reportText(audit: AuditResult): string {
  const lines: string[] = [];
  const fmt = (n: number | undefined) => (typeof n === "number" ? n.toFixed(1) : "—");
  for (const key of SCORE_KEYS) {
    const b = audit.before?.[key];
    const a = audit.after?.[key];
    lines.push(`${SCORE_LABELS[key]}: before ${fmt(b?.score)} / after ${fmt(a?.score)} (0–10)`);
    for (const f of a?.facts ?? b?.facts ?? []) lines.push(`  Fact: ${f}`);
    for (const s of a?.suggestions ?? b?.suggestions ?? []) lines.push(`  Suggestion: ${s}`);
  }
  if (audit.bold) {
    lines.push(`Bold rule (code check): ${audit.bold.passed}/${audit.bold.checked} lines pass after ${audit.bold.loops} fix loop(s).`);
    for (const f of audit.bold.failures) lines.push(`  Still failing [${f.section}]: ${f.text} — ${f.problems.join(" ")}`);
  }
  for (const f of audit.flags) lines.push(`Fact flag: ${f.issue}${f.fix ? ` Fix: ${f.fix}` : ""}`);
  return lines.join("\n");
}
