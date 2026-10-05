import type { Env } from "../env";
import { fetchWithRetry } from "../lib/http";
import { safeJson } from "../lib/text";

/**
 * Typed decisions by a small «System One» model through OpenRouter's decisions API — Cloudflare's Clef-flash by default
 * (TypeSafe Jev works the same): we describe the situation (`state`, plus up to 4 pictures — Clef reads images) and a
 * question with its options (`criteria`); the model returns one of those options with a probability for each. It decides
 * only — it never writes text — so it is fast, cheap (≈$0.09 per million input tokens, output free) and cannot make
 * anything up. Any failure returns null: the caller then decides as before.
 *
 * Wire format (POST https://openrouter.ai/api/alpha/decisions):
 *   { model, state: {…}, questions: { <name>: { type: "choice", instructions, criteria: { <option>: <meaning> } } },
 *     images?: ["data:image/jpeg;base64,…"] }   (Clef's extension: embedded PNG/JPEG/WebP, max 4, no URLs)
 *   → { answers: { <name>: { choice, probabilities: { <option>: p }, confidence } }, usage }
 */

export interface Decision<K extends string> {
  choice: K;
  confidence: number;
  probabilities: Partial<Record<K, number>>;
}

const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
/** A decision that takes longer than this is not worth waiting for: the usual routing takes over. */
const TIMEOUT_MS = 6000;
/** Pictures take a moment longer to read. */
const IMAGE_TIMEOUT_MS = 9000;
/** Clef's limits: 4 pictures, 4 MiB each, 8 MiB together (decoded). */
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES_BYTES = 8 * 1024 * 1024;

/** The pictures Clef can take: PNG, JPEG or WebP data URIs within its limits (the rest are left out). */
export function decisionImages(urls: string[]): string[] {
  const out: string[] = [];
  let total = 0;
  for (const url of urls) {
    const m = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/.exec(url);
    if (!m) continue;
    const bytes = Math.floor((m[2]!.length * 3) / 4);
    if (bytes > MAX_IMAGE_BYTES || total + bytes > MAX_IMAGES_BYTES) continue;
    out.push(url);
    total += bytes;
    if (out.length === MAX_IMAGES) break;
  }
  return out;
}

export async function decide<K extends string>(
  env: Env,
  state: Record<string, unknown>,
  instructions: string,
  criteria: Record<K, string>,
  images: string[] = [],
): Promise<Decision<K> | null> {
  if (!env.ROUTER_MODEL) return null;
  try {
    const res = await fetchWithRetry(
      DECISIONS_URL,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "content-type": "application/json",
          "HTTP-Referer": env.PUBLIC_URL,
          "X-Title": "AI-secretary",
        },
        body: safeJson({
          model: env.ROUTER_MODEL,
          state,
          questions: { pick: { type: "choice", instructions, criteria } },
          ...(images.length ? { images } : {}),
        }),
        signal: AbortSignal.timeout(images.length ? IMAGE_TIMEOUT_MS : TIMEOUT_MS),
      },
      { attempts: 1 },
    );
    if (!res.ok) {
      console.warn("decide:", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const body = (await res.json()) as { answers?: Record<string, { choice?: unknown; confidence?: unknown; probabilities?: unknown }> };
    const answer = body.answers?.pick;
    const choice = typeof answer?.choice === "string" ? answer.choice : "";
    if (!(choice in criteria)) return null;
    const probabilities = (answer?.probabilities && typeof answer.probabilities === "object" ? answer.probabilities : {}) as Partial<Record<K, number>>;
    const confidence = typeof answer?.confidence === "number" ? answer.confidence : (probabilities[choice as K] ?? 0);
    return { choice: choice as K, confidence, probabilities };
  } catch (err) {
    console.warn("decide:", err instanceof Error ? err.message : err);
    return null;
  }
}
