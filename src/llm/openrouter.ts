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

async function complete(env: Env, body: Record<string, unknown>): Promise<string> {
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
  return complete(env, { model, messages, temperature: 0, ...(hasFile(messages) ? PDF_PLUGIN : {}) });
}

/**
 * Calls an OpenRouter chat model and parses a JSON object reply. The model is configurable through
 * LLM_MODEL / LLM_MODEL_SUMMARY (spec section 3). One extra attempt is made when the reply is not valid JSON.
 */
export async function chatJson(env: Env, model: string, messages: ChatMessage[]): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = await complete(env, { model, messages, temperature: 0, response_format: { type: "json_object" } });
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
  | { role: "assistant"; content: string | null; tool_calls: ToolCall[] }
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

/** One model turn: either a final text or tool calls to run. */
export async function chatWithTools(
  env: Env,
  model: string,
  messages: AgentMessage[],
  tools: ToolSpec[],
  temperature?: number,
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls: ToolCall[]; usage?: TokenUsage }> {
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
      messages,
      ...(tools.length ? { tools: tools.map((t) => ({ type: "function", function: t })) } : {}),
      ...(temperature === undefined ? {} : { temperature }),
      ...(hasFile(messages as { content?: unknown }[]) ? PDF_PLUGIN : {}),
      // gpt-oss reasons before answering; a short think is enough for a calendar request and keeps replies fast.
      ...(model.includes("gpt-oss") ? { reasoning: { effort: "low" } } : {}),
    }),
  });
  await expectOk("openrouter", res);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
    usage?: TokenUsage;
    error?: { message: string };
  };
  if (data.error) throw new Error(`openrouter: ${data.error.message}`);
  const message = data.choices?.[0]?.message;
  return { content: message?.content ?? "", toolCalls: message?.tool_calls ?? [], usage: data.usage };
}
