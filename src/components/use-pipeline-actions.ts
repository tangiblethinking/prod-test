import { useCallback, useRef } from "react";
import { toast } from "sonner";
import { isPlausibleApiKey } from "@/lib/api-key-store";
import { looksLikeHtml } from "@/lib/html-clean";
import {
  analyzeIntent,
  analyzeResume,
  customizeResume,
  extractKeywords,
  fetchJobDescription,
  fixBoldBlocks,
  fullRewrite,
  generateCoverLetter,
  scoreResume,
} from "@/lib/optimize";
import { createRunMemory, memoryToAudit } from "@/lib/run-memory";
import { runScoreRewriteSteps, type RunStepDeps } from "@/lib/run-steps";
import type { JobResult } from "@/lib/job-search";
import {
  MAX_JOB_CHARS,
  type AuditResult,
  type KeywordSet,
  type RunMemory,
  type StepId,
  type StepStatus,
} from "@/lib/pipeline-types";
import type { DocKind } from "@/components/output-panel";

type SetStatuses = React.Dispatch<React.SetStateAction<Record<StepId, StepStatus>>>;
type SetDetails = React.Dispatch<React.SetStateAction<Partial<Record<StepId, string>>>>;

export function usePipelineActions(opts: {
  apiKey: string;
  jobUrl: string;
  setJobUrl: (v: string) => void;
  jobText: string;
  setJobText: (v: string) => void;
  resumeHtml: string;
  keywords: KeywordSet | null;
  setKeywords: (v: KeywordSet | null) => void;
  finalHtml: string | null;
  setFinalHtml: (v: string | null) => void;
  coverHtml: string | null;
  setCoverHtml: (v: string | null) => void;
  setAudit: (v: AuditResult | null) => void;
  setStatuses: SetStatuses;
  setDetails: SetDetails;
  busy: boolean;
  setRunning: (v: boolean) => void;
  setRewriting: (v: boolean) => void;
  setCustomizing: (v: boolean) => void;
  setGeneratingCover: (v: boolean) => void;
  setMode: (v: "pipeline" | "search") => void;
  idleStatuses: () => Record<StepId, StepStatus>;
  setPipelineLog?: (updater: (prev: string[]) => string[]) => void;
}) {
  const {
    apiKey, jobUrl, setJobUrl, jobText, setJobText, resumeHtml,
    keywords, setKeywords, finalHtml, setFinalHtml, coverHtml, setCoverHtml,
    setAudit, setStatuses, setDetails, busy, setRunning, setRewriting,
    setCustomizing, setGeneratingCover, setMode, idleStatuses, setPipelineLog,
  } = opts;

  const mark = useCallback((id: StepId, status: StepStatus, detail?: string) => {
    setStatuses((prev) => ({ ...prev, [id]: status }));
    if (detail) setDetails((prev) => ({ ...prev, [id]: detail }));
  }, [setStatuses, setDetails]);

  const fail = useCallback((id: StepId, message: string) => {
    mark(id, "error", message);
    toast.error(message);
  }, [mark]);

  const addLog = useCallback((line?: string) => {
    if (!line || !setPipelineLog) return;
    setPipelineLog((prev) => [...prev, line]);
  }, [setPipelineLog]);

  /** Run memory: created at the start of each run, kept for the Rewrite button. */
  const memoryRef = useRef<RunMemory | null>(null);

  const stepDeps = useCallback((markFn: RunStepDeps["mark"], pause?: () => Promise<void>): RunStepDeps => ({
    score: (which, slice) => scoreResume({ data: { apiKey, which, slice } }),
    rewrite: (slice) => fullRewrite({ data: { apiKey, slice } }),
    fixBold: (html) => fixBoldBlocks({ data: { apiKey, html } }),
    mark: markFn,
    log: addLog,
    pause,
  }), [apiKey, addLog]);

  const toastBusy = useCallback(() => {
    toast.message("Please wait", {
      description: "A task is still running. Finish it before starting a new one.",
    });
  }, []);

  const resetPipeline = useCallback(() => {
    setStatuses(idleStatuses());
    setDetails({});
    setKeywords(null);
    setAudit(null);
    setFinalHtml(null);
    setCoverHtml(null);
    setPipelineLog?.(() => []);
    memoryRef.current = null;
  }, [setStatuses, setDetails, setKeywords, setAudit, setFinalHtml, setCoverHtml, idleStatuses, setPipelineLog]);

  const runPipeline = useCallback(async (runOpts?: { url?: string; skipResetUrl?: boolean }) => {
  const BRIEF_CHECK_MS = 1200;
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    if (busy) { toastBusy(); return; }
    const urlToUse = (runOpts?.url ?? jobUrl).trim();
    if (!isPlausibleApiKey(apiKey)) { toast.error("Save a Gemini API key first."); return; }
    if (!looksLikeHtml(resumeHtml)) { toast.error("The resume must be HTML, not plain text."); return; }
    if (urlToUse.length < 8) { toast.error("Enter a valid job description URL."); return; }
    if (runOpts?.skipResetUrl) setJobUrl(urlToUse);

    setRunning(true);
    resetPipeline();
    const original = resumeHtml.trim();
    let currentJob = jobText.trim();
    let currentKeywords: KeywordSet | null = null;

    try {
      // 1. Job Spec Scraper
      mark(1, "running", "Collecting full job description text…");
      const fetched = await fetchJobDescription({ data: { url: urlToUse } });
      if (fetched.ok) {
        currentJob = fetched.text.slice(0, MAX_JOB_CHARS);
        setJobText(currentJob);
      } else if (currentJob.length >= 40) {
        mark(1, "running", `${fetched.error} Using pasted text.`);
      } else {
        fail(1, fetched.error);
        return;
      }
      mark(1, "done", `${currentJob.length.toLocaleString()} characters collected`);
      await sleep(BRIEF_CHECK_MS);

      // Run memory: one object for the whole run, filled step by step.
      const mem = createRunMemory({ originalHtml: original, jobUrl: urlToUse, jobText: currentJob });
      memoryRef.current = mem;

      // 2. Intent & Analysis
      mark(2, "running", "Analyzing what the job is looking for…");
      const intentResult = await analyzeIntent({ data: { apiKey, jobText: currentJob } });
      addLog(intentResult.log);
      if (!intentResult.ok) { fail(2, intentResult.error); return; }
      mem.intent = intentResult.intent;
      mem.priorities = intentResult.priorities;
      mark(2, "done", intentResult.intent.slice(0, 120) || "Intent analyzed");
      await sleep(BRIEF_CHECK_MS);

      // 3. Keyword & Phrase Extraction
      mark(3, "running", "Extracting keywords and phrases…");
      const extracted = await extractKeywords({ data: { apiKey, jobText: currentJob } });
      addLog(extracted.log);
      if (!extracted.ok) { fail(3, extracted.error); return; }
      currentKeywords = extracted.keywords;
      mem.keywords = currentKeywords;
      setKeywords(currentKeywords);
      mark(3, "done", `${currentKeywords.keywords.length + currentKeywords.phrases.length} keywords / phrases extracted`);
      await sleep(BRIEF_CHECK_MS);

      // 4. Resume Analysis
      mark(4, "running", "Extracting all information from the resume…");
      const resumeAnalysis = await analyzeResume({ data: { apiKey, resumeHtml: original } });
      addLog(resumeAnalysis.log);
      if (!resumeAnalysis.ok) { fail(4, resumeAnalysis.error); return; }
      mem.resume_facts = resumeAnalysis.analysis;
      mark(4, "done", "Resume facts extracted");
      await sleep(BRIEF_CHECK_MS);

      // 5–9. Score original → full rewrite → bold check & fix → score rewrite → final
      const steps = await runScoreRewriteSteps(mem, stepDeps(mark, () => sleep(BRIEF_CHECK_MS)));
      memoryRef.current = steps.mem;
      if (!steps.ok) {
        // Visible failure; no output is shown as if it were a rewrite.
        if (steps.mem.before) setAudit(memoryToAudit(steps.mem));
        toast.error(`Step ${steps.step} failed: ${steps.error}`);
        return;
      }
      setAudit(memoryToAudit(steps.mem));
      setFinalHtml(steps.mem.final_html);
      for (const w of steps.warnings) toast.error(w);
      toast.success("Pipeline finished.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The pipeline failed.");
    } finally {
      setRunning(false);
    }
  }, [busy, jobUrl, apiKey, resumeHtml, jobText, setJobUrl, setJobText, setKeywords, setAudit, setFinalHtml, setRunning, resetPipeline, mark, fail, toastBusy, addLog, stepDeps]);

  /**
   * Rewrite button: runs the new path again (full rewrite → bold check & fix →
   * score rewrite) from the run memory. The original's scores are reused.
   */
  const onRewriteOutput = useCallback(async () => {
    if (busy) { toastBusy(); return; }
    const mem = memoryRef.current;
    if (!finalHtml || !mem || !mem.keywords) { toast.error("Run the pipeline first so there is output to rewrite."); return; }
    if (!isPlausibleApiKey(apiKey)) { toast.error("Save a Gemini API key first."); return; }
    setRewriting(true);
    try {
      const steps = await runScoreRewriteSteps(mem, stepDeps(mark), { reuseBefore: true });
      if (!steps.ok) {
        toast.error(`Rewrite failed at step ${steps.step}: ${steps.error} The output shown is the previous version, unchanged.`);
        return;
      }
      memoryRef.current = steps.mem;
      setAudit(memoryToAudit(steps.mem));
      setFinalHtml(steps.mem.final_html);
      for (const w of steps.warnings) toast.error(w);
      toast.success("Rewrite complete. Output and scores updated.");
    } catch (err) {
      toast.error(`${err instanceof Error ? err.message : "Rewrite failed."} The output shown is the previous version, unchanged.`);
    } finally {
      setRewriting(false);
    }
  }, [busy, finalHtml, apiKey, mark, stepDeps, setAudit, setFinalHtml, setRewriting, toastBusy]);

  const onCustomizeOutput = useCallback(async (instructions: string, kind: DocKind) => {
    if (busy) { toastBusy(); return; }
    const target = kind === "cover" ? coverHtml : finalHtml;
    if (!target) {
      toast.error(kind === "cover" ? "Generate a cover letter first." : "Run the pipeline first.");
      return;
    }
    if (!isPlausibleApiKey(apiKey)) { toast.error("Save a Gemini API key first."); return; }
    const trimmed = instructions.trim();
    if (trimmed.length < 3) { toast.error("Enter edit instructions."); return; }
    setCustomizing(true);
    try {
      const result = await customizeResume({ data: { apiKey, resumeHtml: target, instructions: trimmed } });
      if (!result.ok) { toast.error(result.error); return; }
      if (kind === "cover") setCoverHtml(result.html);
      else setFinalHtml(result.html);
      toast.success("Customize complete. Output updated.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Customize failed.");
    } finally {
      setCustomizing(false);
    }
  }, [busy, coverHtml, finalHtml, apiKey, setCoverHtml, setFinalHtml, setCustomizing, toastBusy]);

  const onGenerateCover = useCallback(async () => {
    if (busy) { toastBusy(); return; }
    if (!finalHtml) { toast.error("Finish the pipeline first."); return; }
    if (!isPlausibleApiKey(apiKey)) { toast.error("Save a Gemini API key first."); return; }
    const job = jobText.trim();
    if (job.length < 40) { toast.error("Job description text is too short."); return; }
    setGeneratingCover(true);
    try {
      const result = await generateCoverLetter({
        data: { apiKey, jobText: job, resumeHtml: finalHtml, keywords: keywords ?? undefined },
      });
      if (!result.ok) { toast.error(result.error); return; }
      setCoverHtml(result.html);
      toast.success("Cover letter ready.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Cover letter generation failed.");
    } finally {
      setGeneratingCover(false);
    }
  }, [busy, finalHtml, apiKey, jobText, keywords, setCoverHtml, setGeneratingCover, toastBusy]);

  const sendToInputs = useCallback((job: JobResult) => {
    if (busy) { toastBusy(); return; }
    resetPipeline();
    setJobText("");
    setJobUrl(job.applicationUrl);
    setMode("pipeline");
    toast.success(`Sent to Pipeline: ${job.title}`, { description: "Starting the alignment pipeline…" });
    void (async () => {
      await new Promise((r) => setTimeout(r, 80));
      await runPipeline({ url: job.applicationUrl, skipResetUrl: true });
    })();
  }, [busy, resetPipeline, setJobText, setJobUrl, setMode, runPipeline, toastBusy]);

  return {
    runPipeline,
    onRewriteOutput,
    onCustomizeOutput,
    onGenerateCover,
    sendToInputs,
    resetPipeline,
    toastBusy,
  };
}
