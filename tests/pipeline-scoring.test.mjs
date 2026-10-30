// Run: node --test tests/pipeline-scoring.test.mjs
// Unit tests for the scoring + full-rewrite path. No network: Gemini is mocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createJiti } from "jiti";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@/": path.join(root, "src") + "/" } });
const load = (p) => jiti.import(path.join(root, p));

const bold = await load("src/lib/bold-check.ts");
const schema = await load("src/lib/score-schema.ts");
const memory = await load("src/lib/run-memory.ts");
const steps = await load("src/lib/run-steps.ts");
const gemini = await load("src/lib/gemini.server.ts");
const jobFetch = await load("src/lib/job-fetch.server.ts");
const slots = await load("src/lib/html-text-slots.ts");
const types = await load("src/lib/pipeline-types.ts");

const GOOD = '<li><strong>Design system governance</strong> cut review time by <strong>40%</strong> across <strong>12</strong> product teams in two years.</li>';

/* ───── validateBold ───── */
test("validateBold: dual-anchor line passes", () => {
  const r = bold.validateBold(`<ul>${GOOD}</ul>`);
  assert.equal(r.checked, 1);
  assert.equal(r.ok, true);
});
test("validateBold: missing lead-in fails", () => {
  const r = bold.validateBold('<ul><li>Cut review time by <strong>40%</strong> across all of the product teams in the org.</li></ul>');
  assert.equal(r.ok, false);
  assert.match(r.failures[0].problems.join(" "), /No bold lead-in/);
});
test("validateBold: loose numbers, $, %, N+ fail", () => {
  for (const tok of ["40%", "$2.1M", "12+", "300"]) {
    const r = bold.validateBold(`<ul><li><strong>Cost control</strong> reduced vendor spend by ${tok} over the fiscal planning cycle.</li></ul>`);
    assert.equal(r.ok, false, tok);
    assert.match(r.failures[0].problems.join(" "), /Numbers not bold/, tok);
  }
});
test("validateBold: numbers-only bold (lead-in is a number) fails", () => {
  const r = bold.validateBold('<ul><li><strong>40%</strong> faster review cycle for the whole design organization this year.</li></ul>');
  assert.equal(r.ok, false);
});
test("validateBold: no number needs a second anchor", () => {
  const one = bold.validateBold('<ul><li><strong>Accessibility</strong> audits now run on every release across the web platform.</li></ul>');
  assert.equal(one.ok, false);
  const two = bold.validateBold('<ul><li><strong>Accessibility</strong> audits now run on every release across the <strong>enterprise</strong> web platform.</li></ul>');
  assert.equal(two.ok, true);
});
test("validateBold: over 45% bold, long lead-in and X+ placeholder fail", () => {
  assert.equal(bold.validateBold('<ul><li><strong>Led the entire migration of every single legacy service</strong> in <strong>3</strong> months.</li></ul>').ok, false);
  const ph = bold.validateBold('<p><strong>Product design</strong> leader with X+ years of <strong>enterprise</strong> experience in fintech.</p>');
  assert.match(ph.failures[0].problems.join(" "), /placeholder/);
});
test("validateBold: contact, short and role-header lines are skipped; years are not numbers", () => {
  const html = '<p>jane@example.com | (555) 123-4567</p><p>Skills</p><p>Senior Product Designer | Acme Corp | 2019 – Present</p>' +
    '<ul><li><strong>Design ops</strong> rebuilt the intake process in 2021 for the <strong>enterprise</strong> design team.</li></ul>';
  const r = bold.validateBold(html);
  assert.equal(r.checked, 1);
  assert.equal(r.ok, true);
});
test("readBlocks / replaceBlocks only touch the given blocks", () => {
  const html = '<ul><li>a long first line without any bold in it at all</li><li>second</li></ul>';
  assert.deepEqual(bold.readBlocks(html, [1]), [{ index: 1, html: "second" }]);
  const out = bold.replaceBlocks(html, new Map([[0, "<strong>X</strong> y"]]));
  assert.equal(out, '<ul><li><strong>X</strong> y</li><li>second</li></ul>');
});
test("auditFacts: new numbers and missing headings are flagged; 12+ totals are not", () => {
  const orig = '<h2>Experience</h2><h2>Education</h2><li>Cut cost 20%</li>';
  const rew = '<h2>Experience</h2><li><strong>12+</strong> years; cut cost <strong>20%</strong> and <strong>35%</strong></li>';
  const flags = bold.auditFacts(orig, rew).map((f) => f.issue).join("\n");
  assert.match(flags, /"35%"/);
  assert.doesNotMatch(flags, /"12\+"/);
  assert.doesNotMatch(flags, /"20%"/);
  assert.match(flags, /education/);
});

/* ───── scores: rounding + schema ───── */
test("round1: one decimal, clamped 0–10", () => {
  assert.equal(schema.round1(7.46), 7.5);
  assert.equal(schema.round1(7.44), 7.4);
  assert.equal(schema.round1(11), 10);
  assert.equal(schema.round1(-2), 0);
  assert.equal(schema.round1(Number.NaN), 0);
});
const item = (score) => ({ score, facts: ["f"], suggestions: ["s"] });
const fullReport = (score = 6.44) => Object.fromEntries([...types.SCORE_KEYS.map((k) => [k, item(score)]), ["fabrication_flags", []]]);
test("parseScoreReport: coerces strings, rounds, filters non-strings", () => {
  const raw = fullReport("6.44");
  raw.job_fit = { score: 8.25, facts: ["ok", 3, ""], suggestions: [] };
  const r = schema.parseScoreReport(raw);
  assert.equal(r.ats_engine_readiness.score, 6.4);
  assert.equal(r.job_fit.score, 8.3);
  assert.deepEqual(r.job_fit.facts, ["ok"]);
  assert.deepEqual(r.fabrication_flags, []);
});
test("parseScoreReport: missing category or non-number score is rejected", () => {
  const raw = fullReport();
  delete raw.human_scannability;
  assert.throws(() => schema.parseScoreReport(raw));
  assert.throws(() => schema.parseScoreReport({ ...fullReport(), job_fit: { score: "high" } }));
});
test("Gemini response schema requires all five scores and flags", () => {
  assert.deepEqual(schema.GEMINI_SCORE_SCHEMA.required, [...types.SCORE_KEYS, "fabrication_flags"]);
  for (const k of types.SCORE_KEYS) assert.deepEqual(schema.GEMINI_SCORE_SCHEMA.properties[k].required, ["score", "facts", "suggestions"]);
  assert.equal(schema.fixBlocksSchema.parse({ blocks: [{ index: "3", html: "x" }] }).blocks[0].index, 3);
});

/* ───── memory plumbing ───── */
const JOB = "We need a senior product designer with design systems, accessibility and research experience.";
const ORIG = "<html><head><style>p{}</style></head><body><h2>Experience</h2><ul><li>Cut review time 40% for 12 teams</li></ul></body></html>";
function filledMemory() {
  const m = memory.createRunMemory({ originalHtml: ORIG, jobUrl: "https://x.test/job", jobText: JOB });
  m.intent = "Owns the design system";
  m.priorities = ["design systems"];
  m.keywords = { keywords: ["Figma"], phrases: ["design systems"], must_have: ["accessibility"], nice_to_have: ["research"] };
  m.resume_facts = '{"roles":[]}';
  return m;
}
test("createRunMemory starts empty except inputs", () => {
  const m = memory.createRunMemory({ originalHtml: ORIG, jobUrl: "u", jobText: JOB });
  assert.equal(m.original_html, ORIG);
  assert.equal(m.before, null);
  assert.equal(m.final_html, null);
  assert.deepEqual(m.fact_flags, []);
});
test("scoreSlice: before scores the original; after scores the rewrite and sends the original", () => {
  const m = filledMemory();
  const b = memory.scoreSlice(m, "before");
  assert.equal(b.documentHtml, ORIG);
  assert.equal("originalHtml" in b, false);
  assert.equal("resumeFacts" in b, false, "scoring does not need resume facts");
  m.final_html = "<p>new</p>";
  const a = memory.scoreSlice(m, "after");
  assert.equal(a.documentHtml, "<p>new</p>");
  assert.equal(a.originalHtml, ORIG);
  assert.deepEqual(a.keywords.must_have, ["accessibility"]);
});
test("rewriteSlice: carries intent, keywords, facts, before scores and every suggestion", () => {
  const m = filledMemory();
  m.before = schema.parseScoreReport(fullReport(5));
  m.before.fabrication_flags = [{ issue: "i", fix: "f" }];
  const s = memory.rewriteSlice(m);
  assert.equal(s.intent, "Owns the design system");
  assert.equal(s.resumeFacts, '{"roles":[]}');
  assert.equal(s.suggestions.length, 6);
  assert.match(s.suggestions[0], /^\[ATS engine readiness\] s$/);
  assert.match(s.suggestions[5], /^\[Fact check\] i Fix: f$/);
  assert.equal(s.beforeScores.job_fit.score, 5);
  assert.equal("suggestions" in s.beforeScores.job_fit, false);
});
test("compactFacts caps size and handles objects", () => {
  assert.equal(memory.compactFacts({ a: 1 }), '{"a":1}');
  assert.equal(memory.compactFacts("x".repeat(30000)).length, 24000);
  assert.equal(memory.compactFacts(null), "");
});
test("memoryToAudit + reportText", () => {
  const m = filledMemory();
  m.before = schema.parseScoreReport(fullReport(4));
  m.after = schema.parseScoreReport(fullReport(8.06));
  m.bold = { checked: 3, passed: 2, loops: 2, failures: [{ index: 1, section: "Experience", text: "t", problems: ["p"] }] };
  m.fact_flags = [{ issue: "Number \"35%\" is new", fix: "remove" }];
  const audit = memory.memoryToAudit(m);
  const text = memory.reportText(audit);
  assert.match(text, /ATS engine readiness: before 4\.0 \/ after 8\.1 \(0–10\)/);
  assert.match(text, /2\/3 lines pass after 2 fix loop/);
  assert.match(text, /Fact flag: Number "35%" is new/);
});

/* ───── steps 5–9 with mocked server calls ───── */
const GOOD_DOC = `<html><head></head><body><ul>${GOOD}</ul></body></html>`;
const BAD_DOC = '<html><head></head><body><ul><li>Cut review time by 40% across all twelve of the product teams.</li></ul></body></html>';
function harness(over = {}) {
  const calls = [];
  const marks = [];
  const deps = {
    score: async (which, slice) => { calls.push(["score", which, slice]); return { ok: true, report: schema.parseScoreReport(fullReport(which === "before" ? 4 : 8)) }; },
    rewrite: async (slice) => { calls.push(["rewrite", slice]); return { ok: true, html: GOOD_DOC }; },
    fixBold: async (html) => { calls.push(["fix", html]); return { ok: true, html: GOOD_DOC, fixed: 1 }; },
    mark: (id, status, detail) => marks.push([id, status, detail]),
    ...over,
  };
  return { deps, calls, marks };
}
test("steps run in order 5→6→7→8→9 and fill memory", async () => {
  const h = harness();
  const r = await steps.runScoreRewriteSteps(filledMemory(), h.deps);
  assert.equal(r.ok, true);
  assert.deepEqual(h.calls.map((c) => c[0] + (c[1] && typeof c[1] === "string" ? ":" + c[1] : "")), ["score:before", "rewrite", "score:after"]);
  assert.deepEqual(h.marks.filter((m) => m[1] === "done").map((m) => m[0]), [5, 6, 7, 8, 9]);
  assert.equal(r.mem.before.job_fit.score, 4);
  assert.equal(r.mem.after.job_fit.score, 8);
  assert.equal(r.mem.final_html, GOOD_DOC);
  assert.equal(r.mem.bold.loops, 0);
  // rewrite got the before suggestions from memory
  assert.equal(h.calls[1][1].suggestions.length, 5);
  // after-scoring saw the rewrite, not the original
  assert.equal(h.calls[2][2].documentHtml, GOOD_DOC);
});
test("bold loop: failing lines go to the fixer, at most 2 loops", async () => {
  const h = harness({
    rewrite: async () => ({ ok: true, html: BAD_DOC }),
    fixBold: async (html) => ({ ok: true, html, fixed: 0 }), // never fixes
  });
  const r = await steps.runScoreRewriteSteps(filledMemory(), h.deps);
  assert.equal(r.ok, true);
  assert.equal(r.mem.bold.loops, 2);
  assert.equal(r.mem.bold.failures.length, 1);
  const h2 = harness({ rewrite: async () => ({ ok: true, html: BAD_DOC }) });
  const r2 = await steps.runScoreRewriteSteps(filledMemory(), h2.deps);
  assert.equal(r2.mem.bold.loops, 1);
  assert.equal(r2.mem.bold.failures.length, 0);
  assert.equal(r2.mem.final_html, GOOD_DOC);
});
test("rewrite failure stops at step 6 with no final html (old text is never passed off as new)", async () => {
  const h = harness({ rewrite: async () => ({ ok: false, error: "429" }) });
  const r = await steps.runScoreRewriteSteps(filledMemory(), h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.step, 6);
  assert.equal(r.mem.final_html, null);
  assert.ok(h.marks.some((m) => m[0] === 6 && m[1] === "error"));
});
test("after-score failure keeps the rewrite and reports a warning", async () => {
  const h = harness({ score: async (which) => which === "before" ? { ok: true, report: schema.parseScoreReport(fullReport(4)) } : { ok: false, error: "bad json" } });
  const r = await steps.runScoreRewriteSteps(filledMemory(), h.deps);
  assert.equal(r.ok, true);
  assert.equal(r.mem.after, null);
  assert.match(r.warnings.join(), /bad json/);
  assert.ok(h.marks.some((m) => m[0] === 8 && m[1] === "error"));
});
test("Rewrite button path reuses the original's scores (no second before-score call)", async () => {
  const m = filledMemory();
  m.before = schema.parseScoreReport(fullReport(3));
  const h = harness();
  const r = await steps.runScoreRewriteSteps(m, h.deps, { reuseBefore: true });
  assert.equal(r.ok, true);
  assert.equal(h.calls.filter((c) => c[0] === "score" && c[1] === "before").length, 0);
  assert.equal(r.mem.before.job_fit.score, 3);
});

/* ───── Gemini client with mocked fetch ───── */
const realFetch = globalThis.fetch;
function mockFetch(responses) {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (!next) throw new Error("no more mock responses");
    if (next === "timeout") { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
    return new Response(JSON.stringify(next.body), { status: next.status });
  };
  return seen;
}
const okBody = (text, finishReason = "STOP") => ({ status: 200, body: { candidates: [{ content: { parts: [{ text }] }, finishReason }] } });
const base = { apiKey: "k".repeat(39), messages: [{ role: "system", content: "S" }, { role: "user", content: "U" }], maxTokens: 999999, temperature: 0.1, backoffMs: 0 };

test("gemini: payload clamps output to 65,536 and carries responseSchema + JSON mime", async () => {
  const seen = mockFetch([okBody('{"a":1}')]);
  const r = await gemini.geminiChat({ ...base, responseSchema: { type: "OBJECT" } });
  globalThis.fetch = realFetch;
  assert.equal(r.ok, true);
  assert.equal(r.meta.model, gemini.FREE_TIER_MODELS[0]);
  const gc = seen[0].body.generationConfig;
  assert.equal(gc.maxOutputTokens, 65536);
  assert.equal(gc.responseMimeType, "application/json");
  assert.deepEqual(gc.responseSchema, { type: "OBJECT" });
  assert.equal(seen[0].body.systemInstruction.parts[0].text, "S");
});
test("gemini: 404 and timeout move to the next model; model order is strongest first", async () => {
  const seen = mockFetch([{ status: 404, body: { error: { message: "not found" } } }, "timeout", okBody("hi")]);
  const r = await gemini.geminiChat(base);
  globalThis.fetch = realFetch;
  assert.equal(r.ok, true);
  assert.deepEqual(seen.map((s) => s.url.match(/models\/([^:]+)/)[1]), gemini.FREE_TIER_MODELS.slice(0, 3));
  assert.equal(gemini.FREE_TIER_MODELS[0], "gemini-3.8-flash");
});
test("gemini: 429 with short retryDelay retries the same model", async () => {
  const seen = mockFetch([{ status: 429, body: { error: { message: "quota", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "0s" }] } } }, okBody("hi")]);
  const r = await gemini.geminiChat(base);
  globalThis.fetch = realFetch;
  assert.equal(r.ok, true);
  assert.equal(seen[0].url, seen[1].url);
});
test("gemini: 429 everywhere returns a visible rate-limit error", async () => {
  const many = Array.from({ length: 30 }, () => ({ status: 429, body: { error: { message: "quota", details: [{ retryDelay: "60s" }] } } }));
  mockFetch(many);
  const r = await gemini.geminiChat(base);
  globalThis.fetch = realFetch;
  assert.equal(r.ok, false);
  assert.equal(r.status, 429);
  assert.match(r.error, /rate limit/i);
});
test("gemini: schema rejected (400) retries the same model without the schema", async () => {
  const seen = mockFetch([{ status: 400, body: { error: { message: "Invalid JSON payload: responseSchema" } } }, okBody("{}")]);
  const r = await gemini.geminiChat({ ...base, responseSchema: { type: "OBJECT" } });
  globalThis.fetch = realFetch;
  assert.equal(r.ok, true);
  assert.equal(seen[0].url, seen[1].url);
  assert.equal(seen[1].body.generationConfig.responseSchema, undefined);
  assert.equal(seen[1].body.generationConfig.responseMimeType, "application/json");
});
test("gemini: invalid API key stops immediately", async () => {
  const seen = mockFetch([{ status: 400, body: { error: { message: "API key not valid. Please pass a valid API key." } } }]);
  const r = await gemini.geminiChat(base);
  globalThis.fetch = realFetch;
  assert.equal(r.ok, false);
  assert.equal(seen.length, 1);
  assert.match(r.error, /key was rejected/);
});
test("gemini: empty answer (all output spent) moves to the next model; 5xx retries", async () => {
  const seen = mockFetch([okBody("", "MAX_TOKENS"), { status: 503, body: {} }, okBody("hi")]);
  const r = await gemini.geminiChat(base);
  globalThis.fetch = realFetch;
  assert.equal(r.ok, true);
  assert.equal(seen.length, 3);
  assert.equal(seen[1].url, seen[2].url);
});
test("gemini: time budget stops the loop with a clear error", async () => {
  mockFetch([]);
  const r = await gemini.geminiChat({ ...base, deadlineMs: 1000 });
  globalThis.fetch = realFetch;
  assert.equal(r.ok, false);
  assert.match(r.error, /time budget/);
});

/* ───── other fixes ───── */
test("job-fetch: entities decode correctly, &amp; last", () => {
  assert.equal(jobFetch.decodeEntities("a &amp; b &lt;p&gt; &quot;q&quot; it&#39;s &apos; &#x2014; &#8212; &amp;lt;"), 'a & b <p> "q" it\'s \' — — &lt;');
});
test("humanizeOutput keeps <strong> around numbers and keeps 'X+ years' for the validator", () => {
  const out = slots.humanizeOutput("<p><strong>40%</strong> and X+ years [X]</p>");
  assert.match(out, /<strong>40%<\/strong>/);
  assert.match(out, /X\+ years/);
  assert.doesNotMatch(out, /\[X\]/);
});
test("removed undo code stays removed", () => {
  const opt = readFileSync(path.join(root, "src/lib/optimize.ts"), "utf8");
  assert.doesNotMatch(opt, /<strong>\$1 \$2<\/strong>/, "sanitizeHtml must not merge strong tags");
  assert.doesNotMatch(opt, /summary contains a job title/);
  assert.doesNotMatch(opt, /Stretching the truth/);
  const ui = readFileSync(path.join(root, "src/components/use-pipeline-actions.ts"), "utf8");
  for (const fn of ["rewriteResume", "terminologyPass", "naturalLanguagePass", "scannabilityPass", "auditAndQA"]) {
    assert.doesNotMatch(ui, new RegExp(`\\b${fn}\\b`), `${fn} must not run on the new path`);
  }
});
test("pipeline has 9 steps with the new names", () => {
  assert.deepEqual(types.PIPELINE_STEPS.map((s) => s.title), [
    "Job Spec Scraper", "Intent & Analysis", "Keyword & Phrase Extraction", "Resume Analysis",
    "Score Original", "Full Rewrite", "Bold Rule Check & Fix", "Score Rewrite", "Final HTML",
  ]);
});
