import type { Env } from "../env";
import { fetchWithRetry } from "../lib/http";

/**
 * Typed decisions by a small «System One» model (TypeSafe Jev through OpenRouter's decisions API): we describe the
 * situation (`state`) and a question with its options (`criteria`); the model returns one of those options with a
 * probability for each. It decides only — it never writes text — so it is fast, cheap (≈$0.04 per million input
 * tokens, output free) and cannot make anything up. Any failure returns null: the caller then decides as before.
 *
 * Wire format (POST https://openrouter.ai/api/alpha/decisions):
 *   { model, state: {…}, questions: { <name>: { type: "choice", instructions, criteria: { <option>: <meaning> } } } }
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

export async function decide<K extends string>(
  env: Env,
  state: Record<string, unknown>,
  instructions: string,
  criteria: Record<K, string>,
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
        body: JSON.stringify({ model: env.ROUTER_MODEL, state, questions: { pick: { type: "choice", instructions, criteria } } }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
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
