import type { AuditFlag, BoldFailure } from "@/lib/pipeline-types";

/**
 * Deterministic checks. No AI. Runs in the browser and on the server.
 * A "block" is one <li>, <p>, <td> or <dd> element: one bullet, one summary
 * paragraph, one competency line.
 */
const BLOCK_RE = /<(li|p|td|dd)\b[^>]*>([\s\S]*?)<\/\1>/gi;
const HEADING_RE = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi;
const BOLD_RE = /<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi;
const NUMBER_RE = /(?:[$€£]\s?)?\d[\d,.]*(?:\s?(?:%|\+|x|k|K|M|MM|B))?/g;
const LEAD_IN_RE = /^\s*(?:<(?!\/?(?:strong|b)\b)[a-z][^>]*>\s*)*<(strong|b)\b[^>]*>([^<]{2,80})<\/\1>/i;
const PLACEHOLDER_RE = /\bX\+|\[[A-Za-z0-9_ +]{1,20}\]|\{\{[^}]*\}\}/;

export function blockText(innerHtml: string): string {
  return innerHtml
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function isYear(token: string): boolean {
  return /^(19|20)\d{2}$/.test(token.trim());
}

/** Contact lines, dates and short labels are not held to the bold rule. */
function isStructural(text: string): boolean {
  if (text.length < 25) return true;
  if (/@|https?:\/\/|www\./i.test(text)) return true;
  if (/\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/.test(text)) return true;
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}\s*[–—-]/i.test(text)) return true;
  // Role header lines: "Title | Company | 2019 – Present"
  if (text.length < 140 && /\b(19|20)\d{2}\s*(?:[–—-]|to)\s*(?:(19|20)\d{2}|present|current|now)\b/i.test(text)) return true;
  return false;
}

function sectionAt(html: string, offset: number): string {
  let current = "Header";
  HEADING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEADING_RE.exec(html)) !== null) {
    if (m.index > offset) break;
    current = blockText(m[1]) || current;
  }
  return current;
}

export type BoldCheck = { ok: boolean; checked: number; passed: number; failures: BoldFailure[] };

export function validateBold(html: string): BoldCheck {
  const failures: BoldFailure[] = [];
  let checked = 0;
  let index = -1;
  BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOCK_RE.exec(html)) !== null) {
    index++;
    const inner = m[2];
    if (/<(li|p|td|dd)\b/i.test(inner)) continue;
    const text = blockText(inner);
    if (isStructural(text)) continue;
    checked++;
    const problems: string[] = [];

    const lead = inner.match(LEAD_IN_RE);
    const leadWords = lead ? blockText(lead[2]).split(" ").filter(Boolean).length : 0;
    if (!lead) problems.push("No bold lead-in term at the start of the line.");
    else if (leadWords > 8) problems.push(`Bold lead-in is ${leadWords} words; keep it to 1–8 words.`);
    else if (!/[A-Za-z]/.test(lead[2])) problems.push("Bold lead-in is only a number; it must be a concept term.");

    const boldParts: string[] = [];
    BOLD_RE.lastIndex = 0;
    let b: RegExpExecArray | null;
    while ((b = BOLD_RE.exec(inner)) !== null) boldParts.push(blockText(b[2]));
    const unbolded = blockText(inner.replace(BOLD_RE, " "));
    const looseNumbers = (unbolded.match(NUMBER_RE) || []).map((n) => n.trim()).filter((n) => /\d/.test(n) && !isYear(n));
    const allNumbers = (text.match(NUMBER_RE) || []).filter((n) => /\d/.test(n) && !isYear(n.trim()));

    if (looseNumbers.length > 0) problems.push(`Numbers not bold: ${[...new Set(looseNumbers)].join(", ")}.`);
    if (allNumbers.length === 0 && boldParts.length < 2) {
      problems.push("No number in this line, so it needs a second bold anchor (the key outcome or scope term).");
    }
    const boldChars = boldParts.join("").length;
    if (text.length > 0 && boldChars / text.length > 0.45) problems.push("More than 45% of the line is bold.");
    if (PLACEHOLDER_RE.test(text)) problems.push("Contains a placeholder such as X+ or [ ].");

    if (problems.length > 0) {
      failures.push({ index, section: sectionAt(html, m.index), text: text.slice(0, 220), problems });
    }
  }
  return { ok: failures.length === 0, checked, passed: checked - failures.length, failures };
}

/** Return the inner HTML of the blocks at the given indexes (same numbering as validateBold). */
export function readBlocks(html: string, indexes: number[]): { index: number; html: string }[] {
  const want = new Set(indexes);
  const out: { index: number; html: string }[] = [];
  let index = -1;
  BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOCK_RE.exec(html)) !== null) {
    index++;
    if (want.has(index)) out.push({ index, html: m[2] });
  }
  return out;
}

/** Replace the inner HTML of the blocks at the given indexes. Tag and attributes stay as they were. */
export function replaceBlocks(html: string, replacements: Map<number, string>): string {
  let index = -1;
  return html.replace(BLOCK_RE, (full, tag: string, inner: string) => {
    index++;
    const next = replacements.get(index);
    if (next === undefined) return full;
    return full.replace(inner, () => next);
  });
}

function numberSet(html: string): Set<string> {
  const text = blockText(html);
  return new Set((text.match(NUMBER_RE) || []).map((n) => n.replace(/[,\s]/g, "").replace(/\.$/, "")).filter((n) => /\d/.test(n)));
}

/** Fact check without AI: every number and every section heading in the rewrite must exist in the original. */
export function auditFacts(originalHtml: string, rewrittenHtml: string): AuditFlag[] {
  const flags: AuditFlag[] = [];
  const before = numberSet(originalHtml);
  for (const n of numberSet(rewrittenHtml)) {
    // "12+" style totals are calculated from the dates, not copied.
    if (/\+$/.test(n)) continue;
    if (!before.has(n)) flags.push({ issue: `Number "${n}" is in the rewrite but not in the original.`, fix: "Remove it or replace it with a number from the original." });
  }
  const headings = (html: string) => {
    const list: string[] = [];
    HEADING_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HEADING_RE.exec(html)) !== null) list.push(blockText(m[1]).toLowerCase());
    return list;
  };
  const after = new Set(headings(rewrittenHtml));
  for (const h of headings(originalHtml)) {
    if (h && !after.has(h)) flags.push({ issue: `Section heading "${h}" from the original is missing.`, fix: "Restore the heading." });
  }
  return flags;
}
