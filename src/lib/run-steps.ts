import { auditFacts, validateBold } from "@/lib/bold-check";
import { rewriteSlice, scoreSlice, type RewriteSlice, type ScoreSlice } from "@/lib/run-memory";
import type { RunMemory, ScoreReport, StepId, StepStatus } from "@/lib/pipeline-types";

/**
 * Steps 5–9 of the pipeline, written against injected functions so the order,
 * the memory plumbing and the bold-fix loop can be tested without a network.
 */
type Fail = { ok: false; error: string; log?: string };

export type RunStepDeps = {
  score: (which: "before" | "after", slice: ScoreSlice) => Promise<{ ok: true; report: ScoreReport; log?: string } | Fail>;
  rewrite: (slice: RewriteSlice) => Promise<{ ok: true; html: string; log?: string } | Fail>;
  fixBold: (html: string) => Promise<{ ok: true; html: string; fixed: number; log?: string } | Fail>;
  mark: (id: StepId, status: StepStatus, detail?: string) => void;
  log?: (line?: string) => void;
  /** Pause after each step so the rail shows it (UI only; tests pass none). */
  pause?: () => Promise<void>;
};

export type RunStepsResult =
  | { ok: true; mem: RunMemory; warnings: string[] }
  | { ok: false; mem: RunMemory; step: StepId; error: string };

export const MAX_BOLD_FIX_LOOPS = 2;

function avg(r: ScoreReport): string {
  return `ATS ${r.ats_engine_readiness.score.toFixed(1)} · fit ${r.job_fit.score.toFixed(1)} · AI ${r.ai_written_likelihood.score.toFixed(1)} · pass ${r.ats_pass_to_human_chance.score.toFixed(1)} · scan ${r.human_scannability.score.toFixed(1)}`;
}

export async function runScoreRewriteSteps(
  input: RunMemory,
  deps: RunStepDeps,
  opts: { reuseBefore?: boolean } = {},
): Promise<RunStepsResult> {
  const mem: RunMemory = { ...input, draft_html: null, final_html: null, after: null, bold: null, fact_flags: [] };
  const pause = deps.pause ?? (async () => {});
  const warnings: string[] = [];

  // 5. Score the original
  if (opts.reuseBefore && mem.before) {
    deps.mark(5, "done", `Reused scores of the original: ${avg(mem.before)}`);
  } else {
    deps.mark(5, "running", "Scoring the submitted resume…");
    const before = await deps.score("before", scoreSlice(mem, "before"));
    deps.log?.(before.log);
    if (!before.ok) { deps.mark(5, "error", before.error); return { ok: false, mem, step: 5, error: before.error }; }
    mem.before = before.report;
    deps.mark(5, "done", avg(before.report));
  }
  await pause();

  // 6. Full rewrite from the whole memory
  deps.mark(6, "running", "Rewriting the whole resume…");
  const rewritten = await deps.rewrite(rewriteSlice(mem));
  deps.log?.(rewritten.log);
  if (!rewritten.ok) { deps.mark(6, "error", rewritten.error); return { ok: false, mem, step: 6, error: rewritten.error }; }
  mem.draft_html = rewritten.html;
  deps.mark(6, "done", "Full rewrite returned");
  await pause();

  // 7. Code-only bold check; failing lines go back to the model (max 2 loops)
  deps.mark(7, "running", "Checking the dual-anchor bold rule…");
  let html = rewritten.html;
  let check = validateBold(html);
  let loops = 0;
  while (!check.ok && loops < MAX_BOLD_FIX_LOOPS) {
    loops++;
    deps.mark(7, "running", `${check.failures.length} line(s) fail the bold rule; fix loop ${loops} of ${MAX_BOLD_FIX_LOOPS}…`);
    const fixed = await deps.fixBold(html);
    deps.log?.(fixed.log);
    if (!fixed.ok) {
      warnings.push(`Bold fix loop ${loops} failed: ${fixed.error}`);
      break;
    }
    html = fixed.html;
    check = validateBold(html);
  }
  mem.final_html = html;
  mem.bold = { checked: check.checked, passed: check.passed, loops, failures: check.failures };
  mem.fact_flags = auditFacts(mem.original_html, html);
  deps.mark(7, "done", `${check.passed}/${check.checked} lines pass after ${loops} fix loop(s)`);
  await pause();

  // 8. Score the rewrite
  deps.mark(8, "running", "Scoring the rewrite…");
  const after = await deps.score("after", scoreSlice(mem, "after"));
  deps.log?.(after.log);
  if (!after.ok) {
    // The rewrite is kept and shown; the missing after-scores are reported, not hidden.
    deps.mark(8, "error", after.error);
    warnings.push(`Scoring the rewrite failed: ${after.error}`);
  } else {
    mem.after = after.report;
    deps.mark(8, "done", avg(after.report));
  }
  await pause();

  // 9. Final HTML
  deps.mark(9, "done", "Final HTML ready");
  return { ok: true, mem, warnings };
}
