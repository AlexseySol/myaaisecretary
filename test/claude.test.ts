import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent/runner";
import { chatText, estimateTokens, pdfPart } from "../src/llm/openrouter";
import { mockFetch, testEnv } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const HAIKU = "anthropic/claude-haiku-5.5";
type Body = { model: string; temperature?: number; messages: { role: string; content: unknown; reasoning_details?: unknown }[] };

/** OpenRouter answering with the given replies in turn; every request body is kept. */
function openRouter(replies: Record<string, unknown>[]) {
  const bodies: Body[] = [];
  mockFetch([
    (url, init) => {
      if (url.hostname !== "openrouter.ai") return undefined;
      bodies.push(JSON.parse(init.bodyText));
      return Response.json(replies[Math.min(bodies.length - 1, replies.length - 1)]);
    },
  ]);
  return bodies;
}

const tool = { spec: { name: "get_x", description: "x", parameters: { type: "object", properties: {} } }, run: async () => "result" };
const callTool = (extra: Record<string, unknown> = {}) => ({
  choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "get_x", arguments: "{}" } }], ...extra } }],
  usage: { prompt_tokens: 1000 },
});
const answer = { choices: [{ message: { content: "Готово" } }], usage: { prompt_tokens: 1200 } };

describe("Claude Haiku as the main model", () => {
  it("no temperature, the system prompt cached, its thinking sent back with the tool results", async () => {
    const bodies = openRouter([callTool({ reasoning_details: [{ type: "reasoning.encrypted", data: "sig" }] }), answer]);
    const { env } = testEnv();
    const text = await runAgent(env, { model: HAIKU, system: "Ти — агент.", history: [], input: "привіт", tools: [tool], maxIterations: 3, temperature: 0.2 });
    expect(text).toBe("Готово");
    expect(bodies[0]!.temperature).toBeUndefined();
    expect(bodies[0]!.messages[0]!.content).toEqual([{ type: "text", text: "Ти — агент.", cache_control: { type: "ephemeral" } }]);
    const assistant = bodies[1]!.messages.find((m) => m.role === "assistant")!;
    expect(assistant.reasoning_details).toEqual([{ type: "reasoning.encrypted", data: "sig" }]);
  });

  it("another model keeps its temperature and gets no cache marks", async () => {
    const bodies = openRouter([answer]);
    const { env } = testEnv();
    await runAgent(env, { model: "openai/gpt-6-luna-pro", system: "s", history: [], input: "привіт", tools: [], maxIterations: 1, temperature: 0.2 });
    expect(bodies[0]!.temperature).toBe(0.2);
    expect(bodies[0]!.messages[0]!.content).toBe("s");
  });

  it("a prompt over 100 000 tokens goes to LLM_MODEL, and the run stays there", async () => {
    const big = "а".repeat(260_000); // ≈ 104 000 tokens
    const bodies = openRouter([callTool(), answer]);
    const { env } = testEnv();
    await runAgent(env, { model: HAIKU, system: "s", history: [], input: big, tools: [tool], maxIterations: 3 });
    expect(bodies.map((b) => b.model)).toEqual(["test/strong-model", "test/strong-model"]);
  });

  it("the provider's own count decides the next step: a run that grows over the line moves on", async () => {
    const bodies = openRouter([{ ...callTool(), usage: { prompt_tokens: 95_000 } }, answer]);
    const { env } = testEnv();
    await runAgent(env, { model: HAIKU, system: "s", history: [], input: "привіт", tools: [tool], maxIterations: 3 });
    expect(bodies.map((b) => b.model)).toEqual([HAIKU, "test/strong-model"]);
  });

  it("a long PDF counts by its pages; a single call (summaries, files) moves on too", async () => {
    const pages = Array.from({ length: 150 }, (_, i) => `${i} 0 obj << /Type /Page >> endobj`).join("\n");
    const pdf = pdfPart("big.pdf", Buffer.from(`%PDF-1.4\n<< /Type /Pages >>\n${pages}`).toString("base64"));
    expect(estimateTokens([{ content: [pdf] }])).toBe(150 * 800);
    const bodies = openRouter([answer]);
    const { env } = testEnv();
    await chatText(env, HAIKU, [{ role: "user", content: [{ type: "text", text: "Перекажи" }, pdf] }]);
    expect(bodies[0]!.model).toBe("test/strong-model");
    expect(bodies[0]!.temperature).toBe(0);
  });
});
