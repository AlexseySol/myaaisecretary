import { safeJson } from "../lib/text";
import type { Env } from "../env";
import { expectOk, fetchWithRetry } from "../lib/http";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

/** A PDF for the model: OpenRouter extracts its text (the free pdf-text engine) before the model reads it. */
export const pdfPart = (filename: string, base64: string): ContentPart => ({ type: "file", file: { filename, file_data: `data:application/pdf;base64,${base64}` } });
const PDF_PLUGIN = { plugins: [{ id: "file-parser", pdf: { engine: "pdf-text" } }] };
const hasFile = (messages: { content?: unknown }[]) =>
  messages.some((m) => Array.isArray(m.content) && (m.content as ContentPart[]).some((p) => p.type === "file"));

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

/** Extracts a JSON object from a model reply, tolerating ```json fences and surrounding prose. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error(`LLM reply is not JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * Which provider serves a model: OpenRouter picks among several (an OpenAI model is also served by Azure). The model's
 * own maker goes first; the others stay as the fallback when it is down.
 */
export function providerFor(model: string): Record<string, unknown> {
  const maker = model.split("/")[0];
  return maker === "openai" ? { provider: { order: ["openai"], allow_fallbacks: true } } : {};
}

/** A Claude model (Anthropic through OpenRouter). */
export const isClaude = (model: string) => model.startsWith("anthropic/");

/**
 * Claude Haiku has two price cards: up to 100 000 prompt tokens, and a five times dearer one above. A request that
 * would go over it is sent to LLM_MODEL instead; the margin covers the estimate being rough.
 */
export const BIG_PROMPT_TOKENS = 90_000;

// Ukrainian text is about 2.5 characters a token (fewer for English, so this errs on the big side).
const CHARS_PER_TOKEN = 2.5;
const IMAGE_TOKENS = 1_600;
const PDF_PAGE_TOKENS = 800;

/** Roughly how many prompt tokens these messages are: text, pictures, PDF pages (counted in the file). */
export function estimateTokens(messages: { content?: unknown; tool_calls?: unknown }[]): number {
  let chars = 0;
  let tokens = 0;
  for (const m of messages) {
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
    if (typeof m.content === "string") chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const part of m.content as ContentPart[]) {
        if (part.type === "text") chars += part.text.length;
        else if (part.type === "image_url") tokens += IMAGE_TOKENS;
        else if (part.type === "file") tokens += pdfPages(part.file.file_data) * PDF_PAGE_TOKENS;
      }
    }
  }
  return tokens + Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Pages of a PDF (data URL): its «/Type /Page» objects; at least one. */
function pdfPages(dataUrl: string): number {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const pages = Buffer.from(b64, "base64").toString("latin1").match(/\/Type\s*\/Page(?!s)/g)?.length ?? 0;
  return Math.max(1, pages);
}

/** The model for this request: a Claude model over the big-prompt line goes to LLM_MODEL. */
export function pickModel(env: Env, model: string, promptTokens: number): string {
  return isClaude(model) && promptTokens > BIG_PROMPT_TOKENS ? env.LLM_MODEL : model;
}

/**
 * What a model needs besides the messages. Claude: no temperature (Haiku 5.5 refuses any but its own), its adaptive
 * thinking at its default effort, and prompt caching marked on the system prompt — the same prompt goes again with
 * every tool step, and a cached read costs a tenth.
 */
function modelParams(model: string, temperature?: number): Record<string, unknown> {
  if (isClaude(model)) return {};
  return {
    ...(temperature === undefined ? {} : { temperature }),
    // gpt-oss reasons before answering; a short think is enough for a calendar request and keeps replies fast.
    ...(model.includes("gpt-oss") ? { reasoning: { effort: "low" } } : {}),
  };
}

/** Claude: the system prompt as a cached block (OpenRouter passes cache_control on to Anthropic). */
function withCache<T extends { role: string; content?: unknown }>(model: string, messages: T[]): T[] {
  if (!isClaude(model)) return messages;
  return messages.map((m) =>
    m.role === "system" && typeof m.content === "string" ? { ...m, content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }] } : m,
  );
}

async function complete(env: Env, body: Record<string, unknown> & { model: string; messages: ChatMessage[] }, temperature?: number): Promise<string> {
  const model = pickModel(env, body.model, estimateTokens(body.messages));
  body = { ...body, model, messages: withCache(model, body.messages), ...modelParams(model, temperature) };
  const res = await fetchWithRetry("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
      "HTTP-Referer": env.PUBLIC_URL,
      "X-Title": "AI-secretary",
    },
    body: safeJson({ ...body, ...providerFor(String(body.model ?? "")) }),
  });
  await expectOk("openrouter", res);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; error?: { message: string } };
  if (data.error) throw new Error(`openrouter: ${data.error.message}`);
  return data.choices?.[0]?.message?.content ?? "";
}

/** Calls an OpenRouter chat model and returns its plain-text reply. */
export async function chatText(env: Env, model: string, messages: ChatMessage[]): Promise<string> {
  return complete(env, { model, messages, ...(hasFile(messages) ? PDF_PLUGIN : {}) }, 0);
}

/**
 * Calls an OpenRouter chat model and parses a JSON object reply. The model is configurable through
 * LLM_MODEL / LLM_MODEL_SUMMARY (spec section 3). One extra attempt is made when the reply is not valid JSON.
 */
export async function chatJson(env: Env, model: string, messages: ChatMessage[]): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = await complete(env, { model, messages, response_format: { type: "json_object" } }, 0);
    try {
      return extractJson(content);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------------------------------------------
// Tool calling (OpenAI-compatible, through OpenRouter) — the n8n "AI Agent" nodes.

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type AgentMessage =
  | ChatMessage
  // reasoning_details: Claude's thinking of that step, sent back unchanged with the tool results (OpenRouter).
  | { role: "assistant"; content: string | null; tool_calls: ToolCall[]; reasoning_details?: unknown[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** Tokens (and, when OpenRouter reports it, the cost in USD) of one model call. */
export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
}

/**
 * One model turn: either a final text or tool calls to run. `model` is the one that answered — a Claude model over
 * the big-prompt line hands the turn to LLM_MODEL (`promptTokens`: the caller's count, else an estimate).
 */
export async function chatWithTools(
  env: Env,
  requested: string,
  messages: AgentMessage[],
  tools: ToolSpec[],
  temperature?: number,
  signal?: AbortSignal,
  promptTokens?: number,
): Promise<{ content: string; toolCalls: ToolCall[]; usage?: TokenUsage; model: string; reasoningDetails?: unknown[] }> {
  const model = pickModel(env, requested, promptTokens ?? estimateTokens(messages));
  // Another model cannot read Claude's thinking: it is left out when the turn moves on.
  const sent = isClaude(model) ? messages : messages.map((m) => ("reasoning_details" in m ? { ...m, reasoning_details: undefined } : m));
  const res = await fetchWithRetry("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
      "HTTP-Referer": env.PUBLIC_URL,
      "X-Title": "AI-secretary",
    },
    body: safeJson({
      model,
      ...providerFor(model),
      messages: withCache(model, sent),
      ...(tools.length ? { tools: tools.map((t) => ({ type: "function", function: t })) } : {}),
      ...modelParams(model, temperature),
      ...(hasFile(messages as { content?: unknown }[]) ? PDF_PLUGIN : {}),
    }),
  });
  await expectOk("openrouter", res);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: ToolCall[]; reasoning_details?: unknown[] } }[];
    usage?: TokenUsage;
    error?: { message: string };
  };
  if (data.error) throw new Error(`openrouter: ${data.error.message}`);
  const message = data.choices?.[0]?.message;
  return {
    content: message?.content ?? "",
    toolCalls: message?.tool_calls ?? [],
    usage: data.usage,
    model,
    ...(message?.reasoning_details?.length ? { reasoningDetails: message.reasoning_details } : {}),
  };
}
