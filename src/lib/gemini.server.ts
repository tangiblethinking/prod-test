type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatMeta = {
  model: string;
  finishReason?: string;
  inputChars: number;
  outputChars: number;
};

export type ChatResult =
  | { ok: true; text: string; meta: ChatMeta }
  | { ok: false; error: string; status?: number; meta?: Partial<ChatMeta> };

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Model order, tried until one succeeds.
 * Sources (checked 2026-10-30):
 *  - https://ai.google.dev/gemini-api/docs/models  (current model list; 2.5 models are
 *    limited to projects that already used them, new projects should use 3.5 Flash-Lite / 3.8 Flash)
 *  - https://ai.google.dev/gemini-api/docs/models/<model>  (each: input 1,048,576 tokens, output 65,536 tokens)
 *  - https://ai.google.dev/gemini-api/docs/pricing  (all models below show a free tier)
 *  - https://ai.google.dev/gemini-api/docs/rate-limits  (RPM / TPM / RPD per project, RPD resets
 *    at midnight Pacific; exact free numbers are only shown in AI Studio)
 * Strongest first: scoring and the full rewrite need the reasoning, and a 429 or a
 * missing model simply moves on to the next one.
 */
export const FREE_TIER_MODELS = [
  "gemini-3.8-flash",
  "gemini-2.5-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash-lite",
] as const;

/** Every model above has a 65,536 output-token limit (thinking tokens count toward it). */
export const MAX_OUTPUT_TOKENS = 65536;

function statusError(status: number): string {
  if (status === 400) {
    return "The request was rejected (400).";
  }
  if (status === 401 || status === 403) {
    return "The Google API key was rejected. Create a free key at aistudio.google.com/apikey.";
  }
  if (status === 404) {
    return "That Gemini model is not available on this key.";
  }
  if (status === 429) {
    return "Google rate limit hit (429) on every model tried. Wait a minute, or until midnight Pacific if the daily limit is used up, and run again.";
  }
  if (status >= 500) {
    return "The Gemini service is unavailable. Try again shortly.";
  }
  return `The API returned an error (${status}).`;
}

/** Reads Google's error body: message and the RetryInfo delay, if any. Never throws. */
async function readErrorDetail(res: Response): Promise<{ message: string; retryDelaySec?: number }> {
  try {
    const body = (await res.json()) as {
      error?: { message?: string; details?: { "@type"?: string; retryDelay?: string }[] };
    };
    const message = (body.error?.message ?? "").slice(0, 240);
    const delay = body.error?.details?.find((d) => typeof d.retryDelay === "string")?.retryDelay;
    const retryDelaySec = delay ? Number.parseFloat(delay) : undefined;
    return { message, retryDelaySec: Number.isFinite(retryDelaySec) ? retryDelaySec : undefined };
  } catch {
    return { message: "" };
  }
}

async function parseGenerateBody(res: Response): Promise<{ text: string; finishReason?: string }> {
  const body = (await res.json()) as {
    candidates?: {
      content?: { parts?: { text?: string }[] };
      finishReason?: string;
    }[];
    error?: { message?: string; status?: string };
  };

  if (body.error?.message) {
    throw new Error(body.error.message);
  }

  const parts = body.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();

  const finishReason = body.candidates?.[0]?.finishReason;

  if (!text) {
    throw new Error(
      finishReason
        ? `The model returned an empty response (${finishReason}).`
        : "The model returned an empty response.",
    );
  }
  return { text, finishReason };
}

function buildPayload(opts: {
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  json?: boolean;
  urlContext?: boolean;
  images?: { mimeType: string; data: string }[];
  responseSchema?: Record<string, unknown>;
}): Record<string, unknown> {
  const systemParts = opts.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .filter(Boolean);
  const contents = opts.messages
    .filter((m) => m.role !== "system")
    .map((m, idx, arr) => {
      const parts: Record<string, unknown>[] = [{ text: m.content }];
      const isLastUser = m.role === "user" && idx === arr.length - 1;
      if (isLastUser && opts.images?.length) {
        for (const img of opts.images) {
          parts.push({
            inline_data: { mime_type: img.mimeType, data: img.data },
          });
        }
      }
      return {
        role: m.role === "assistant" ? "model" : "user",
        parts,
      };
    });

  const wantsJson = Boolean(opts.json || opts.responseSchema);
  const payload: Record<string, unknown> = {
    contents,
    generationConfig: {
      maxOutputTokens: Math.max(1, Math.min(opts.maxTokens, MAX_OUTPUT_TOKENS)),
      temperature: opts.temperature,
      ...(wantsJson ? { responseMimeType: "application/json" as const } : {}),
      ...(opts.responseSchema ? { responseSchema: opts.responseSchema } : {}),
    },
  };

  if (systemParts.length > 0) {
    payload.systemInstruction = {
      parts: systemParts.map((text) => ({ text })),
    };
  }

  if (opts.urlContext) {
    payload.tools = [{ url_context: {} }];
  }

  return payload;
}

/** Exported for tests. */
export { buildPayload as buildGeminiPayload };

function estimateInputChars(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function geminiChat(opts: {
  apiKey: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  json?: boolean;
  urlContext?: boolean;
  images?: { mimeType: string; data: string }[];
  /** Structured output (OpenAPI-subset schema, generationConfig.responseSchema). */
  responseSchema?: Record<string, unknown>;
  /** Timeout for one HTTP request. Default 90 s. */
  timeoutMs?: number;
  /** Total time budget across all models and retries. Default 240 s. */
  deadlineMs?: number;
  /** Override the model order (tests). */
  models?: readonly string[];
  /** Wait before retrying (tests pass 0). */
  backoffMs?: number;
}): Promise<ChatResult> {
  const started = Date.now();
  const deadline = started + (opts.deadlineMs ?? 240_000);
  const perRequest = opts.timeoutMs ?? 90_000;
  const backoff = opts.backoffMs ?? 1500;
  const models = opts.models ?? FREE_TIER_MODELS;
  let payload = buildPayload(opts);
  let schemaDropped = false;
  const inputChars = estimateInputChars(opts.messages);
  const headers = {
    "Content-Type": "application/json",
    "x-goog-api-key": opts.apiKey,
  };

  let lastError = "Could not reach the model service.";
  let lastStatus: number | undefined;
  let lastModel: string | undefined;

  for (const model of models) {
    lastModel = model;
    const url = `${GEMINI_BASE}/models/${model}:generateContent`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining < 2000) {
        return {
          ok: false,
          error: `Stopped after ${Math.round((Date.now() - started) / 1000)} s (time budget used). Last error: ${lastError}`,
          status: lastStatus,
          meta: { model: lastModel, inputChars, outputChars: 0 },
        };
      }
      const controller = new AbortController();
      const waitMs = Math.min(perRequest, remaining);
      const timeoutId = setTimeout(() => controller.abort(), waitMs);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeoutId);
        lastError = err instanceof Error && err.name === "AbortError"
          ? `${model} did not answer within ${Math.round(waitMs / 1000)} s.`
          : "Could not reach the model service.";
        break; // next model
      }
      clearTimeout(timeoutId);

      if (res.ok) {
        try {
          const { text, finishReason } = await parseGenerateBody(res);
          return {
            ok: true,
            text,
            meta: { model, finishReason, inputChars, outputChars: text.length },
          };
        } catch (err) {
          // Empty or unreadable answer (for example all output spent on thinking): next model.
          lastError = `${model}: ${err instanceof Error ? err.message : "The model response could not be read."}`;
          break;
        }
      }

      lastStatus = res.status;
      const detail = await readErrorDetail(res);
      lastError = `${model}: ${statusError(res.status)}${detail.message ? ` ${detail.message}` : ""}`;

      if (res.status === 401) {
        return { ok: false, error: statusError(401), status: 401, meta: { model, inputChars, outputChars: 0 } };
      }
      if ((res.status === 400 || res.status === 403) && /api[ _-]?key/i.test(detail.message)) {
        return { ok: false, error: statusError(403), status: res.status, meta: { model, inputChars, outputChars: 0 } };
      }
      // Structured output rejected: retry the same model once with plain JSON mode.
      if (res.status === 400 && opts.responseSchema && !schemaDropped) {
        payload = buildPayload({ ...opts, responseSchema: undefined, json: true });
        schemaDropped = true;
        continue;
      }
      if (res.status === 429) {
        const delaySec = detail.retryDelaySec ?? 0;
        // Short per-minute limit: wait and retry this model; long or daily: next model.
        if (attempt < 2 && delaySec <= 20 && deadline - Date.now() > delaySec * 1000 + 5000) {
          await sleepMs(delaySec > 0 ? delaySec * 1000 : backoff * (attempt + 1));
          continue;
        }
        break;
      }
      if (res.status >= 500) {
        if (attempt < 2) {
          await sleepMs(backoff * (attempt + 1));
          continue;
        }
        break;
      }
      // 400 / 403 / 404: model not available on this key → next model.
      break;
    }
  }

  return { ok: false, error: lastError, status: lastStatus, meta: { model: lastModel, inputChars, outputChars: 0 } };
}

/**
 * Multimodal chat: text + optional PDF (base64) for document understanding.
 */
export async function geminiChatWithPdf(opts: {
  apiKey: string;
  system: string;
  userText: string;
  pdfBase64: string;
  maxTokens: number;
  temperature: number;
}): Promise<ChatResult> {
  const payload: Record<string, unknown> = {
    systemInstruction: {
      parts: [{ text: opts.system }],
    },
    contents: [
      {
        role: "user",
        parts: [
          {
            inline_data: {
              mime_type: "application/pdf",
              data: opts.pdfBase64,
            },
          },
          { text: opts.userText },
        ],
      },
    ],
    generationConfig: {
      maxOutputTokens: opts.maxTokens,
      temperature: opts.temperature,
    },
  };

  const inputChars = (opts.system?.length ?? 0) + (opts.userText?.length ?? 0);
  const headers = {
    "Content-Type": "application/json",
    "x-goog-api-key": opts.apiKey,
  };

  let lastError = "Could not reach the model service.";
  let lastStatus: number | undefined;

  for (const model of FREE_TIER_MODELS) {
    const url = `${GEMINI_BASE}/models/${model}:generateContent`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    } catch {
      lastError = "Could not reach the model service.";
      continue;
    }

    if (!res.ok && res.status >= 500) {
      try {
        res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });
      } catch {
        lastError = "Could not reach the model service.";
        continue;
      }
    }

    if (res.ok) {
      try {
        const { text, finishReason } = await parseGenerateBody(res);
        return {
          ok: true,
          text,
          meta: {
            model,
            finishReason,
            inputChars,
            outputChars: text.length,
          },
        };
      } catch (err) {
        return {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : "The model response could not be read.",
          meta: { model, inputChars, outputChars: 0 },
        };
      }
    }

    lastStatus = res.status;
    lastError = statusError(res.status);

    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: lastError, status: res.status, meta: { model, inputChars, outputChars: 0 } };
    }

    if (res.status === 404 || res.status === 400 || res.status === 429) {
      continue;
    }

    return { ok: false, error: lastError, status: res.status, meta: { model, inputChars, outputChars: 0 } };
  }

  return { ok: false, error: lastError, status: lastStatus };
}

export async function verifyGeminiKey(apiKey: string): Promise<ChatResult> {
  // List models is the lightest way to validate a Google AI Studio key
  const url = `${GEMINI_BASE}/models?pageSize=5`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "x-goog-api-key": apiKey },
    });
  } catch {
    return { ok: false, error: "Could not reach the model service." };
  }
  if (!res.ok) {
    return { ok: false, error: statusError(res.status), status: res.status };
  }
  return { ok: true, text: "ok", meta: { model: "list", inputChars: 0, outputChars: 2 } };
}

export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(fenced);
}

export function formatChatLog(label: string, result: ChatResult, extra?: string): string {
  if (!result.ok) {
    const m = result.meta;
    return `[${label}] FAIL model=${m?.model ?? "?"} finish=${m?.finishReason ?? "-"} in=${m?.inputChars ?? "?"} out=${m?.outputChars ?? 0} err=${result.error}${extra ? " | " + extra : ""}`;
  }
  const m = result.meta;
  return `[${label}] OK model=${m.model} finish=${m.finishReason ?? "-"} in=${m.inputChars} out=${m.outputChars}${extra ? " | " + extra : ""}`;
}
