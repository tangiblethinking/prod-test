const PRIVATE_V4 =
  /^(127\.|10\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.)/;

export function assertPublicHttpUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Enter a valid job URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The job URL must start with http or https.");
  }
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.includes(":") ||
    PRIVATE_V4.test(host)
  ) {
    throw new Error("That URL is not allowed.");
  }
  return url.toString();
}

function safeCodePoint(code: number): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n: string) => safeCodePoint(Number(n)))
    .replace(/&amp;/gi, "&");
}

export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(stripped).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

function extractMeta(html: string, names: string[]): string {
  for (const name of names) {
    const re = new RegExp(
      `<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`,
      "i",
    );
    const alt = new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["']`,
      "i",
    );
    const match = html.match(re) || html.match(alt);
    if (match?.[1]) return decodeEntities(match[1]);
  }
  return "";
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1] ? decodeEntities(match[1].replace(/<[^>]+>/g, "")).trim() : "";
}

function extractJobPosting(html: string): string | null {
  const scripts = html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const block of scripts) {
    const raw = block[1];
    if (!raw) continue;
    try {
      const data = JSON.parse(raw) as unknown;
      const bag: unknown[] = Array.isArray(data)
        ? data
        : data && typeof data === "object"
          ? [data, ...(((data as { "@graph"?: unknown[] })["@graph"] ?? []) as unknown[])]
          : [];
      for (const item of bag) {
        if (!item || typeof item !== "object") continue;
        const rec = item as Record<string, unknown>;
        const type = rec["@type"];
        const isJob =
          type === "JobPosting" ||
          (Array.isArray(type) && type.includes("JobPosting"));
        if (!isJob) continue;
        const org =
          rec.hiringOrganization && typeof rec.hiringOrganization === "object"
            ? String((rec.hiringOrganization as { name?: string }).name ?? "")
            : "";
        const description =
          typeof rec.description === "string" ? htmlToText(decodeEntities(rec.description)) : "";
        const parts = [
          rec.title,
          org,
          description,
          rec.skills,
          rec.qualifications,
          rec.responsibilities,
          rec.experienceRequirements,
          rec.educationRequirements,
        ]
          .flat()
          .filter((v) => typeof v === "string" && v.trim())
          .map((v) => String(v));
        if (parts.length) return parts.join("\n\n");
      }
    } catch {
      // ignore malformed JSON-LD
    }
  }
  return null;
}

export async function fetchJobText(rawUrl: string): Promise<{
  url: string;
  text: string;
  title: string;
}> {
  const url = assertPublicHttpUrl(rawUrl);
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent":
        "Mozilla/5.0 (compatible; ATSAlign/1.0; +https://grok.com) AppleWebKit/537.36 Chrome/122.0.0.0",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(
      `The job page returned ${res.status}. Paste the description text instead.`,
    );
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (
    contentType &&
    !/text\/html|application\/xhtml|text\/plain|application\/json/i.test(contentType)
  ) {
    throw new Error("That URL did not return a web page.");
  }
  const html = await res.text();
  const jsonLd = extractJobPosting(html);
  const title = extractTitle(html);
  const meta = extractMeta(html, [
    "og:description",
    "description",
    "twitter:description",
  ]);
  const visible = htmlToText(html);
  const text = [title, jsonLd || [meta, visible].filter(Boolean).join("\n\n")]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 40_000);

  if (text.replace(/\s+/g, " ").trim().length < 80) {
    throw new Error(
      "The page had almost no readable text (many job boards block fetches). Paste the job description below.",
    );
  }
  return { url, text, title };
}
