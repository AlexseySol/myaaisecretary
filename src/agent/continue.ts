import { createHmac, timingSafeEqual } from "node:crypto";
import type { Env } from "../env";
import type { AgentInput, Step } from "./index";

/**
 * Vercel stops a function at 60 s, and everything a message starts runs inside the one that received it. A long request
 * (several agents, many steps, a slow model) used to die there without a word. Now it is split: an agent run takes no new
 * step after STEP_UNTIL_MS and cuts a model call still running at CUT_MS (runner.ts OutOfTime); what was done so far
 * goes, signed, to the bot's own /api/continue — a fresh invocation with its own 60 s — which carries on from there
 * («не повторюй уже зроблене»). At most MAX_HOPS times; then the owner is told plainly what was done.
 */
export const STEP_UNTIL_MS = 38_000;
export const CUT_MS = 48_000;
/** A retry on the stronger model starts only with this much time used at most; later it goes to the next invocation. */
export const RETRY_UNTIL_MS = 25_000;
export const MAX_HOPS = 3;
/** A request body bigger than this loses its pictures (Vercel takes 4.5 MB). */
const MAX_BODY = 3_500_000;

export interface Continuation {
  /** 1 for the first continuation. */
  hop: number;
  /** Everything the tools did in the earlier invocations. */
  done: Step[];
  /** The model to go on with. */
  model: string;
  /** The live mini-log message and its lines (agent/progress.ts), kept by the continuation. */
  progress?: { id: number | null; lines: string[] };
}

/** The owner's request plus what was already done, for the model of the next invocation. */
export function continuationText(text: string, done: Step[]): string {
  if (!done.length) return text;
  const lines = done.map((s, i) => `${i + 1}. ${s.agent} → ${s.tool}(${s.args}) → ${s.result}`);
  return (
    `${text}\n\n[ПРОДОВЖЕННЯ: цей запит уже почали виконувати, ось зроблені кроки. НЕ повторюй їх (особливо створення, ` +
    `надсилання, зміни) — візьми їхні результати й доведи справу до кінця, потім дай власнику одну підсумкову відповідь.]\n` +
    lines.join("\n")
  );
}

const sign = (env: Env, body: string) => createHmac("sha256", env.ENCRYPTION_KEY).update(body).digest("hex");

export function verifyContinuation(env: Env, body: string, signature: string | null): boolean {
  if (!signature) return false;
  const want = Buffer.from(sign(env, body));
  const got = Buffer.from(signature);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Sends the request on to a fresh invocation. False when it could not be handed over. */
export async function handOff(env: Env, input: AgentInput, cont: Continuation): Promise<boolean> {
  let body = JSON.stringify({ input, cont });
  if (body.length > MAX_BODY) body = JSON.stringify({ input: { ...input, images: [] }, cont });
  try {
    const res = await fetch(`${env.PUBLIC_URL}/api/continue`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ais-sign": sign(env, body) },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.warn("continue: HTTP", res.status);
    return res.ok;
  } catch (err) {
    console.warn("continue:", err instanceof Error ? err.message : err);
    return false;
  }
}
