import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeWithDecision } from "../src/agent/route";
import { handleUpdate } from "../src/telegram/handler";
import type { TgUpdate } from "../src/telegram/types";
import { calendarList, connectGoogle, isSupervisor, lastContent, type LlmRequest, llmText, mockFetch, openRouter, OWNER, resetInstance, runJobs, testEnv } from "./helpers";

beforeEach(() => resetInstance());
afterEach(() => vi.restoreAllMocks());

const ROUTER = { ROUTER_MODEL: "typesafe/jev-1.13" };
const input = (text: string) => ({ chatId: OWNER, inputType: "text" as const, text });

/** A fake decisions endpoint: answers with `choice` (or an error), records every request. */
function decisions(answer: { choice: string; confidence?: number } | "fail", seen: Record<string, unknown>[] = []) {
  return (url: URL, init: RequestInit & { bodyText: string }) => {
    if (url.hostname !== "openrouter.ai" || !url.pathname.endsWith("/alpha/decisions")) return undefined;
    seen.push(JSON.parse(init.bodyText));
    if (answer === "fail") return Response.json({ error: { message: "down" } }, { status: 503 });
    return Response.json({ answers: { pick: { type: "choice", choice: answer.choice, probabilities: { [answer.choice]: answer.confidence ?? 0.9 }, confidence: answer.confidence ?? 0.9 } } });
  };
}

let updateId = 1;
const textUpdate = (text: string): TgUpdate => ({
  update_id: updateId++,
  message: { message_id: updateId + 100, date: Math.floor(Date.now() / 1000), chat: { id: OWNER, type: "private" }, from: { id: OWNER, is_bot: false, first_name: "О" }, text },
});

describe("routing by the decision model (TypeSafe Jev)", () => {
  it("asks one typed question with the conversation in view; Bitrix24 is an option only when connected", async () => {
    const seen: Record<string, unknown>[] = [];
    mockFetch([decisions({ choice: "calendar_agent" }, seen)]);
    const { env } = testEnv(ROUTER);
    const pick = await routeWithDecision(env, input("о 10"), { lastBot: "О котрій завтра?", lastAgent: "calendar_agent", waiting: true }, false);
    expect(pick).toEqual({ route: "calendar_agent", confidence: 0.9 });
    const body = seen[0] as { model: string; state: Record<string, unknown>; questions: { pick: { type: string; criteria: Record<string, string> } } };
    expect(body.model).toBe("typesafe/jev-1.13");
    expect(body.state).toMatchObject({ message: "о 10", bot_last_message: "О котрій завтра?", bot_last_message_by: "calendar_agent", bot_waits_for_answer: true });
    expect(body.questions.pick.type).toBe("choice");
    expect(Object.keys(body.questions.pick.criteria)).toEqual(["calendar_agent", "gmail_agent", "docs_agent", "notes_agent", "several", "chat"]);
    await routeWithDecision(env, input("мої задачі"), {}, true);
    expect(Object.keys((seen[1] as typeof body).questions.pick.criteria)).toContain("bitrix_agent");
  });

  it("unsure, failed, an unknown option or switched off → null, so the usual routing decides", async () => {
    mockFetch([decisions({ choice: "gmail_agent", confidence: 0.3 })]);
    expect(await routeWithDecision(testEnv(ROUTER).env, input("щось"), {}, false)).toBeNull();
    vi.restoreAllMocks();
    mockFetch([decisions("fail")]);
    expect(await routeWithDecision(testEnv(ROUTER).env, input("щось"), {}, false)).toBeNull();
    vi.restoreAllMocks();
    mockFetch([decisions({ choice: "weather_agent" })]);
    expect(await routeWithDecision(testEnv(ROUTER).env, input("щось"), {}, false)).toBeNull();
    vi.restoreAllMocks();
    const seen: Record<string, unknown>[] = [];
    mockFetch([decisions({ choice: "gmail_agent" }, seen)]);
    expect(await routeWithDecision(testEnv().env, input("щось"), {}, false)).toBeNull();
    expect(seen).toHaveLength(0);
  });

  it("its choice sends the message straight to that agent — no Supervisor call", async () => {
    await connectGoogle();
    const seen: LlmRequest[] = [];
    mockFetch([decisions({ choice: "calendar_agent" }), calendarList([]), openRouter(() => llmText("📅 Зустрічей немає"), seen)]);
    const { env, jobs } = testEnv(ROUTER);
    // No calendar keyword at all: only the decision model knows it is about the schedule.
    await handleUpdate(env, textUpdate("я сьогодні вільний?"));
    await runJobs(env, jobs);
    expect(seen.some(isSupervisor)).toBe(false);
    expect(seen[0]!.tools!.map((t) => t.function.name)).toContain("create_event_google_meet");
  });

  it("«several» goes to the Supervisor, which has every agent", async () => {
    await connectGoogle();
    const seen: LlmRequest[] = [];
    mockFetch([decisions({ choice: "several" }), calendarList([]), openRouter((req) => llmText(isSupervisor(req) ? "Готово" : lastContent(req)), seen)]);
    const { env, jobs } = testEnv(ROUTER);
    await handleUpdate(env, textUpdate("постав зустріч з Іваном і напиши йому лист"));
    await runJobs(env, jobs);
    expect(seen.some(isSupervisor)).toBe(true);
  });

  it("when the decision model is down, the keyword table still routes", async () => {
    await connectGoogle();
    const seen: LlmRequest[] = [];
    mockFetch([decisions("fail"), calendarList([]), openRouter(() => llmText("📅 Зустрічей немає"), seen)]);
    const { env, jobs } = testEnv(ROUTER);
    await handleUpdate(env, textUpdate("що в мене сьогодні?"));
    await runJobs(env, jobs);
    expect(seen.some(isSupervisor)).toBe(false);
    expect(seen[0]!.tools!.map((t) => t.function.name)).toContain("create_event_google_meet");
  });
});
