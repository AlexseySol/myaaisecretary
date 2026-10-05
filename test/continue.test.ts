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

describe("find_person: an email by a name — calendar contacts, Bitrix24, then the owner's mail", () => {
  it("a person outside the company is found in the owner's recent mail, whatever the case form", async () => {
    const { findPerson } = await import("../src/agent/peopleTools");
    const { parseAddresses } = await import("../src/google/gmail");
    expect(parseAddresses('"Григорьева, Юлия" <y.g@mail.com>, Олег <oleg@x.ua>, plain@y.com')).toEqual([
      { name: "Григорьева, Юлия", email: "y.g@mail.com" },
      { name: "Олег", email: "oleg@x.ua" },
      { name: "", email: "plain@y.com" },
    ]);
    const { GMAIL_SCOPE } = await import("./helpers");
    await connectGoogle({ scope: GMAIL_SCOPE });
    mockFetch([
      calendarList([]),
      (url) => {
        if (url.hostname !== "gmail.googleapis.com") return undefined;
        if (url.pathname.endsWith("/messages")) return Response.json({ messages: [{ id: "m1" }] });
        return Response.json({ id: "m1", payload: { headers: [{ name: "From", value: "Юлия Григорьева <yulia.g@gmail.com>" }, { name: "To", value: "o.kovalenko@acme.ua" }] } });
      },
    ]);
    const { env } = testEnv();
    expect(await findPerson(env, "Юлией Григорьевой")).toEqual([{ name: "Юлия Григорьева", email: "yulia.g@gmail.com", from: "пошта" }]);
  });
});

describe("nothing changes without the owner's «так» to a 📋 preview", () => {
  it("a plain yes after a preview approves; anything else does not", async () => {
    const { approved, isYes } = await import("../src/agent");
    for (const y of ["так", "Да", "ок", "ставь", "👍", "так, ставь", "давай!", "все вірно", "так, будь ласка"]) expect(isYes(y)).toBe(true);
    for (const n of ["так, постав зустріч з Олегом", "так, але о 15", "да, только на 16:00", "постав зустріч з Юлією", "ні", "змінити", "так, але не Юлію, а Олену"]) expect(isYes(n)).toBe(false);
    expect(approved("так", "📋 Перевірте зустріч … Підтверджуєте? (так / змінити)")).toBe(true);
    expect(approved("так", "Хто буде на зустрічі?")).toBe(false);
    expect(approved("постав зустріч з Юлією завтра о 14", "📋 Перевірте зустріч")).toBe(false);
  });

  it("the agent that finds the person and tries to create at once is refused and shows a preview instead", async () => {
    await connectGoogle();
    const inserted: unknown[] = [];
    const toolResults: string[] = [];
    mockFetch([
      calendarList([]),
      (url, init) => {
        if (url.pathname !== "/calendar/v3/calendars/primary/events" || init.method !== "POST") return undefined;
        inserted.push(init.bodyText);
        return Response.json({ id: "ev1", status: "confirmed" });
      },
      openRouter((req) => {
        const last = req.messages.at(-1)!;
        if (last.role === "tool") {
          toolResults.push(String(last.content));
          return llmText("📋 Перевірте зустріч … Підтверджуєте? (так / змінити)");
        }
        return llmTools([
          "create_event_google_meet",
          { summary: "Зустріч", startDateTime: "2099-10-06T14:00:00+03:00", endDateTime: "2099-10-06T15:00:00+03:00", attendeesJson: '{"email":"y.g@mail.com"}' },
        ]);
      }),
    ]);
    const { env } = testEnv();
    await handleWithAgents(env, input("постав зустріч з Юлією Григорьєвою завтра о 14"));
    expect(inserted).toEqual([]);
    expect(toolResults[0]).toContain("НЕ виконано");
  });
});

describe("a request body is always valid JSON for the model provider", () => {
  it("text is never cut in half an emoji, and a half kept anywhere is cleaned before sending", async () => {
    const { cutText, safeJson, wellFormed } = await import("../src/lib/text");
    expect(cutText("📋 Перевірте", 1)).toBe("…");
    expect(cutText("ab📋", 3)).toBe("ab…");
    expect(cutText("коротко", 50)).toBe("коротко");
    const half = "📋".slice(0, 1);
    expect(wellFormed(`x${half}y`)).toBe("x�y");
    expect(safeJson({ a: [`${half}`] })).not.toContain("\\ud83d");
    // A chat memory that already holds half an emoji (from before) does not break the next request.
    await connectGoogle();
    const bodies: string[] = [];
    mockFetch([
      calendarList([]),
      (url, init) => {
        if (url.hostname === "openrouter.ai" && url.pathname.endsWith("/chat/completions")) bodies.push(init.bodyText);
        return undefined;
      },
      openRouter(() => llmText("Привіт!")),
    ]);
    const { env } = testEnv();
    const { loadMemory, rememberTurn } = await import("../src/agent/memory");
    await loadMemory(env);
    await rememberTurn(env, "питання", `відповідь ${half}`);
    await handleWithAgents(env, input("привіт"));
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) expect(b).not.toMatch(/\\ud8[0-3][0-9a-f](?!\\ud[c-f])/i);
  });
});

describe("the model's own maker serves it first", () => {
  it("an OpenAI model goes to OpenAI first, other providers only as the fallback", async () => {
    const { providerFor } = await import("../src/llm/openrouter");
    expect(providerFor("openai/gpt-6-luna-pro")).toEqual({ provider: { order: ["openai"], allow_fallbacks: true } });
    expect(providerFor("google/gemini-2.5-flash")).toEqual({});
  });
});

describe("a Bitrix24 profile is read whole", () => {
  it("every email in any field (the company's own UF_ fields too) and the filled-in profile", async () => {
    const { toPerson } = await import("../src/bitrix/client");
    const p = toPerson({
      ID: "7",
      NAME: "Юлія",
      LAST_NAME: "Григорьєва",
      EMAIL: "j.private@gmail.com",
      WORK_POSITION: "Менеджер",
      WORK_PHONE: "+380 44 000 00 00",
      UF_USR_WORK_EMAIL: "y.grigorieva@company.ua",
      UF_DEPARTMENT: [12],
      PERSONAL_MOBILE: "",
      ACTIVE: true,
    });
    expect(p.email).toBe("j.private@gmail.com");
    expect(p.emails).toEqual([
      { field: "EMAIL", email: "j.private@gmail.com" },
      { field: "UF_USR_WORK_EMAIL", email: "y.grigorieva@company.ua" },
    ]);
    expect(p.profile).toMatchObject({ WORK_POSITION: "Менеджер", WORK_PHONE: "+380 44 000 00 00", UF_DEPARTMENT: "12" });
    expect(p.profile).not.toHaveProperty("PERSONAL_MOBILE");
  });
});
