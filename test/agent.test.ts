import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calendarTools, parseAttendees } from "../src/agent/calendarTools";
import { gmailTools } from "../src/agent/gmailTools";
import { toTelegramHtml } from "../src/agent/html";
import { ModelError, runAgent, type Tool } from "../src/agent/runner";
import { newMailNotice } from "../src/google/gmailPush";
import { fromBase64Url } from "../src/lib/crypto";
import { connectGoogle, type LlmRequest, llmText, llmTools, mockFetch, openRouter, resetInstance, testEnv } from "./helpers";

beforeEach(() => resetInstance());
afterEach(() => vi.restoreAllMocks());

describe("Parse Agent Output (toTelegramHtml)", () => {
  it("unwraps fences and {response}, turns Markdown into HTML, drops unknown tags, closes open ones, escapes &", () => {
    expect(toTelegramHtml("```html\n<b>Привіт</b>\n```")).toBe("<b>Привіт</b>");
    expect(toTelegramHtml('{"response":"<i>ок</i>"}')).toBe("<i>ок</i>");
    expect(toTelegramHtml("**Важливо** [лінк](https://x.ua)")).toBe('<b>Важливо</b> <a href="https://x.ua">лінк</a>');
    expect(toTelegramHtml("<p>Абзац</p><br><b>жирний")).toBe("Абзац\n\n<b>жирний</b>");
    expect(toTelegramHtml("A & B &amp; C, 1 < 2")).toBe("A &amp; B &amp; C, 1 &lt; 2");
    expect(toTelegramHtml("")).toBe("🙂");
  });

  it("web HTML and Markdown become Telegram's: headings, lists, line breaks, strong/em, code", () => {
    expect(toTelegramHtml("<h2>Розклад</h2><ul><li>Стендап</li><li>Демо</li></ul>")).toBe("<b>Розклад</b>\n\n• Стендап\n• Демо");
    expect(toTelegramHtml("<strong>так</strong> і <em>ні</em> <del>було</del>")).toBe("<b>так</b> і <i>ні</i> <s>було</s>");
    expect(toTelegramHtml("Рядок 1<br/>Рядок 2")).toBe("Рядок 1\nРядок 2");
    expect(toTelegramHtml("### Підсумок\n- перше\n- друге\n*важливо* і `код`")).toBe("<b>Підсумок</b>\n• перше\n• друге\n<i>важливо</i> і <code>код</code>");
    expect(toTelegramHtml("Ось:\n```\nif (a < b) x();\n```")).toBe("Ось:\n<pre>if (a &lt; b) x();</pre>");
  });

  it("never sends what Telegram rejects: crossed tags, stray closers, unsafe or missing links", () => {
    expect(toTelegramHtml("<b>жирний <i>обидва</b> курсив</i>")).toBe("<b>жирний <i>обидва</i></b><i> курсив</i>");
    expect(toTelegramHtml("текст</b> далі")).toBe("текст далі");
    expect(toTelegramHtml('<a href="javascript:alert(1)">клік</a>')).toBe("клік");
    expect(toTelegramHtml("<a>без адреси</a>")).toBe("без адреси");
    expect(toTelegramHtml('<a href="https://x.ua/?a=1&b=2">лінк</a>')).toBe('<a href="https://x.ua/?a=1&amp;b=2">лінк</a>');
    expect(toTelegramHtml("<script>x</script><b></b>ок")).toBe("xок");
  });

  it("a long answer is not cut: Telegram.send splits it, every part valid with its tags whole", async () => {
    const { splitMessage } = await import("../src/telegram/api");
    const out = toTelegramHtml(`<b>${"я ".repeat(3000)}</b>`);
    expect(out.length).toBeGreaterThan(5000);
    const parts = splitMessage(out);
    expect(parts.length).toBe(2);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(4096);
      expect(p.startsWith("<b>")).toBe(true);
      expect(p.endsWith("</b>")).toBe(true);
    }
    const linked = splitMessage(`<a href="https://x.ua">${"слово ".repeat(1000)}</a>`);
    expect(linked[1]!.startsWith('<a href="https://x.ua">')).toBe(true);
  });
});

describe("agent loop", () => {
  it("runs tools until the model answers; a failing tool's error goes back to the model", async () => {
    const seen: LlmRequest[] = [];
    mockFetch([openRouter((_req, n) => (n === 1 ? llmTools(["boom", {}], ["echo", { v: 1 }]) : llmText("готово")), seen)]);
    const { env } = testEnv();
    const tools: Tool[] = [
      { spec: { name: "boom", description: "", parameters: {} }, run: async () => Promise.reject(new Error("нема")) },
      { spec: { name: "echo", description: "", parameters: {} }, run: async (a) => a },
    ];
    const out = await runAgent(env, { model: "m", system: "s", history: [], input: "hi", tools, maxIterations: 5 });
    expect(out).toBe("готово");
    expect(seen[1]!.messages.slice(-2)).toEqual([
      { role: "tool", tool_call_id: "call0", content: '{"error":"нема"}' },
      { role: "tool", tool_call_id: "call1", content: '{"v":1}' },
    ]);
  });

  it("stops after maxIterations", async () => {
    const seen: LlmRequest[] = [];
    mockFetch([openRouter(() => llmTools(["echo", {}]), seen)]);
    const { env } = testEnv();
    const echo: Tool = { spec: { name: "echo", description: "", parameters: {} }, run: async () => "ok" };
    await expect(runAgent(env, { model: "m", system: "s", history: [], input: "hi", tools: [echo], maxIterations: 3 })).rejects.toBeInstanceOf(
      ModelError,
    );
    expect(seen).toHaveLength(3);
  });
});

describe("calendar tools", () => {
  it("parseAttendees reads n8n's attendeesJson, arrays and plain lists", () => {
    expect(parseAttendees('{"email":"a@x.ua"},{"email":"b@y.ua"}')).toEqual([{ email: "a@x.ua" }, { email: "b@y.ua" }]);
    expect(parseAttendees(["a@x.ua", { email: "b@y.ua" }])).toEqual([{ email: "a@x.ua" }, { email: "b@y.ua" }]);
    expect(parseAttendees("a@x.ua, b@y.ua")).toEqual([{ email: "a@x.ua" }, { email: "b@y.ua" }]);
    expect(parseAttendees("")).toEqual([]);
  });

  it("check_free_busy sees each guest's busy time: conflicts at the meeting's time, windows free for all, hidden calendars said", async () => {
    await connectGoogle();
    let asked: unknown;
    mockFetch([
      (url, init) => {
        if (url.pathname === "/calendar/v3/calendars/primary/events") return Response.json({ items: [] });
        if (url.pathname !== "/calendar/v3/freeBusy") return undefined;
        asked = JSON.parse(init.bodyText);
        return Response.json({
          calendars: {
            "oleg@acme.ua": { busy: [{ start: "2099-10-01T15:00:00+03:00", end: "2099-10-01T16:00:00+03:00" }] },
            "guest@gmail.com": { errors: [{ domain: "global", reason: "notFound" }] },
          },
        });
      },
    ]);
    const { env } = testEnv();
    const check = (scope: boolean) => calendarTools(env, "o.kovalenko@acme.ua", { freeBusyScope: scope }).find((t) => t.spec.name === "check_free_busy")!;
    const args = {
      timeMin: "2099-10-01T09:00:00+03:00",
      timeMax: "2099-10-01T19:00:00+03:00",
      attendeesJson: '{"email":"o.kovalenko@acme.ua"},{"email":"oleg@acme.ua"},{"email":"guest@gmail.com"}',
      proposedStart: "2099-10-01T15:00:00+03:00",
      proposedEnd: "2099-10-01T16:00:00+03:00",
      durationMinutes: 60,
    };
    const r = (await check(true).run(args)) as { conflicts: unknown[]; people: { email: string; visible: boolean }[]; free: { from: string; to: string }[] };
    // The owner is not asked about; only the guests.
    expect((asked as { items: { id: string }[] }).items.map((i) => i.id)).toEqual(["oleg@acme.ua", "guest@gmail.com"]);
    expect(r.conflicts).toEqual([{ who: "oleg@acme.ua", busy: "15:00–16:00" }]);
    expect(r.people.find((p) => p.email === "guest@gmail.com")).toMatchObject({ visible: false });
    expect(r.free.map((w) => `${w.from}–${w.to}`)).toEqual(["09:00–15:00", "16:00–19:00"]);
    // Without the permission Google is not asked; the agent is told why.
    asked = undefined;
    const old = (await check(false).run(args)) as { people: { why: string }[] };
    expect(asked).toBeUndefined();
    expect(old.people[0]!.why).toContain("перепідключити Google");
  });

  it("a meeting is never made without knowing who is at it: no guests → ask the owner; «без учасників» → made", async () => {
    await connectGoogle();
    const inserted: unknown[] = [];
    mockFetch([
      (url, init) => {
        if (url.pathname !== "/calendar/v3/calendars/primary/events" || init.method !== "POST") return undefined;
        inserted.push(JSON.parse(init.bodyText));
        return Response.json({ id: "ev1", status: "confirmed" });
      },
    ]);
    const { env } = testEnv();
    const create = calendarTools(env, "o.kovalenko@acme.ua").find((t) => t.spec.name === "create_event_google_meet")!;
    const when = { summary: "Бюджет", startDateTime: "2099-10-01T10:00:00+03:00", endDateTime: "2099-10-01T11:00:00+03:00" };
    // Only the owner: not made, the agent is told to ask.
    expect(JSON.stringify(await create.run({ ...when, attendeesJson: '{"email":"o.kovalenko@acme.ua"}' }))).toContain("Хто буде на зустрічі");
    expect(JSON.stringify(await create.run(when))).toContain("Хто буде на зустрічі");
    expect(inserted).toHaveLength(0);
    // A guest named, or the owner said there are none.
    await create.run({ ...when, attendeesJson: '{"email":"o.kovalenko@acme.ua"},{"email":"o.melnyk@acme.ua"}' });
    await create.run({ ...when, withoutGuests: true });
    expect(inserted).toHaveLength(2);
  });
});

describe("gmail tools", () => {
  it("msg_get_many turns ReadStatus into the Gmail query; msg_send builds the email with CC", async () => {
    await connectGoogle();
    const queries: string[] = [];
    let sent = "";
    mockFetch([
      (url, init) => {
        if (url.hostname !== "gmail.googleapis.com") return undefined;
        if (url.pathname.endsWith("/messages")) {
          queries.push(url.searchParams.get("q")!);
          return Response.json({ messages: [] });
        }
        if (url.pathname.endsWith("/messages/send")) {
          sent = Buffer.from(fromBase64Url(JSON.parse(init.bodyText).raw)).toString("utf8");
          return Response.json({ id: "m1", threadId: "t1" });
        }
        return undefined;
      },
    ]);
    const { env } = testEnv();
    const tools = new Map(gmailTools(env).map((t) => [t.spec.name, t]));
    await tools.get("msg_get_many")!.run({ SearchQuery: "", ReadStatus: "unread" });
    await tools.get("msg_get_many")!.run({ SearchQuery: "from:anna", ReadStatus: "both" });
    expect(queries).toEqual(["is:unread", "from:anna"]);
    await tools.get("msg_send")!.run({ To: "anna@x.ua", Subject: "Звіт", Message: "Привіт", CC: "b@y.ua", BCC: "" });
    expect(sent).toContain("To: anna@x.ua");
    expect(sent).toContain("Cc: b@y.ua");
    expect(sent).not.toContain("Bcc:");
  });
});

describe("new-mail notice (n8n WF3 «Формат»)", () => {
  it("📧 Нова пошта! with sender, subject, recipient, Kyiv time, snippet and the Gmail link", () => {
    const text = newMailNotice({
      id: "18f0a",
      threadId: "t",
      internalDate: String(Date.parse("2026-09-29T07:05:00Z")),
      snippet: "Надсилаю <b>звіт</b> & план",
      payload: {
        headers: [
          { name: "From", value: "Анна <anna@partner.ua>" },
          { name: "To", value: "me@acme.ua" },
          { name: "Subject", value: "Звіт" },
        ],
      },
    } as never);
    expect(text).toBe(
      [
        "📧 <b>Нова пошта!</b>",
        "",
        "📩 <b>Від:</b> Анна &lt;anna@partner.ua&gt;",
        "📌 <b>Тема:</b> Звіт",
        "📨 <b>Кому:</b> me@acme.ua",
        "🕐 29.09.2026, 10:05",
        "",
        "Надсилаю звіт &amp; план",
        "",
        '🔗 <a href="https://mail.google.com/mail/u/0/#inbox/18f0a">Відкрити в Gmail</a>',
      ].join("\n"),
    );
  });
});

