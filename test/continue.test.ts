import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleWithAgents } from "../src/agent";
import { continuationText, MAX_HOPS } from "../src/agent/continue";
import { stepLabel } from "../src/agent/progress";
import { continueWebhook } from "../src/app";
import { calendarList, connectGoogle, type LlmRequest, llmText, llmTools, mockFetch, OWNER, openRouter, resetInstance, runJobs, testEnv, tgCalls } from "./helpers";

beforeEach(() => resetInstance());
afterEach(() => vi.restoreAllMocks());

const input = (text: string) => ({ chatId: OWNER, inputType: "text" as const, text });
const signed = (body: string) => createHmac("sha256", "test-encryption-key").update(body).digest("hex");

/** The bot's own /api/continue: records what was handed over. */
function continueEndpoint(seen: { input: { text: string }; cont: { hop: number; done: { tool: string }[]; model: string } }[], status = 202) {
  return (url: URL, init: RequestInit & { bodyText: string }) => {
    if (url.href !== "https://bot.test/api/continue") return undefined;
    expect((init.headers as Record<string, string>)["x-ais-sign"]).toBe(signed(init.bodyText));
    seen.push(JSON.parse(init.bodyText));
    return new Response("accepted", { status });
  };
}

describe("a request longer than one invocation goes on in the next (Vercel's 60 s)", () => {
  it("out of time after a step: handed over with what was done, on the same model; the owner hears it is in progress", async () => {
    await connectGoogle();
    const handed: Parameters<typeof continueEndpoint>[0] = [];
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const seen: LlmRequest[] = [];
    const calls = mockFetch([
      continueEndpoint(handed),
      calendarList([]),
      openRouter((_req, n) => {
        // The first model call takes almost all the time; the next step would not fit.
        now += 39_000;
        return n === 1 ? llmTools(["get_calendar_events", {}]) : llmText("не мало б статися");
      }, seen),
    ]);
    const { env } = testEnv();
    await handleWithAgents(env, input("що в мене завтра?"), { startedAt: now });
    expect(seen).toHaveLength(1);
    expect(handed).toHaveLength(1);
    expect(handed[0]!.cont.hop).toBe(1);
    expect(handed[0]!.cont.done.map((d) => d.tool)).toEqual(["get_calendar_events"]);
    expect(handed[0]!.input.text).toBe("що в мене завтра?");
    // The live mini-log shows the step instead of silence.
    const texts = tgCalls(calls, "sendMessage").map((m) => String(m.text));
    expect(texts.some((t) => t.includes("Працюю над запитом") && t.includes("Дивлюся календар"))).toBe(true);
  });

  it("the continuation is signed: anything else is refused; a signed one runs with the done steps in view", async () => {
    await connectGoogle();
    const seen: LlmRequest[] = [];
    mockFetch([calendarList([]), openRouter(() => llmText("📅 Завтра зустрічей немає"), seen)]);
    const { env, jobs } = testEnv();
    const body = JSON.stringify({
      input: input("що в мене завтра?"),
      cont: { hop: 1, done: [{ agent: "calendar_agent", tool: "get_calendar_events", args: "{}", result: "[]" }], model: env.AGENT_MODEL },
    });
    const req = (sig: string) => new Request("https://bot.test/api/continue", { method: "POST", body, headers: { "x-ais-sign": sig } });
    expect((await continueWebhook(req("bad"), env)).status).toBe(403);
    expect((await continueWebhook(req(signed(body)), env)).status).toBe(202);
    expect(jobs).toHaveLength(1);
    await runJobs(env, jobs);
    expect(seen.some((r) => JSON.stringify(r.messages).includes("ПРОДОВЖЕННЯ"))).toBe(true);
  });

  it(`after ${MAX_HOPS} continuations the owner is told plainly what was done`, async () => {
    await connectGoogle();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const calls = mockFetch([
      calendarList([]),
      openRouter(() => {
        now += 39_000;
        return llmTools(["get_calendar_events", {}]);
      }),
    ]);
    const { env } = testEnv();
    await handleWithAgents(env, input("що в мене завтра?"), { startedAt: now, cont: { hop: MAX_HOPS, done: [], model: env.AGENT_MODEL } });
    expect(String(tgCalls(calls, "sendMessage").at(-1)!.text)).toContain("Не встиг виконати запит повністю");
  });

  it("the done steps go to the model as «do not repeat»; steps have plain-word labels", () => {
    expect(continuationText("x", [])).toBe("x");
    expect(continuationText("x", [{ agent: "calendar_agent", tool: "create_event_google_meet", args: "{}", result: "{id:1}" }])).toContain("НЕ повторюй");
    expect(stepLabel("check_free_busy")).toBe("🕐 Перевіряю, хто вільний");
    expect(stepLabel("create_event_google_meet")).toBe("📌 Ставлю зустріч");
    expect(stepLabel("whatever")).toBe("⚙️ Працюю");
  });
});
