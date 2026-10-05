import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notesTools } from "../src/agent/notesTools";
import { routeByKeywords } from "../src/agent/route";
import { addNote, noteButton, notesDigest, readNotes, remindsOn, type Note } from "../src/google/notes";
import { loadOwnerSettings, saveOwnerSettings } from "../src/google/oauth";
import { handleReminderEmail } from "../src/google/reminders";
import { shadowId, syncSignals } from "../src/google/signals";
import type { GMessage } from "../src/google/gmail";
import { handleUpdate } from "../src/telegram/handler";
import { ensureNotesSheet, handleNotesButton, notesView } from "../src/bot/notesMenu";
import { loadDigestChoice } from "../src/google/digest";
import { connectGoogle, GMAIL_SCOPE, type LlmRequest, llmText, llmTools, mockFetch, OWNER, openRouter, resetInstance, runJobs, testEnv, tgCalls } from "./helpers";

beforeEach(() => resetInstance());
afterEach(() => vi.restoreAllMocks());

const FULL = `${GMAIL_SCOPE} https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/calendar.app.created`;
const NOW = Date.parse("2026-10-05T09:00:00+03:00"); // a Monday

/** Google in memory: Drive files, one sheet's rows, the signal calendar's events. */
function fakeGoogle() {
  const files = new Map<string, { id: string; name: string; mimeType: string; parents: string[]; trashed?: boolean }>();
  const rows = new Map<string, string[][]>();
  const events = new Map<string, Record<string, unknown> & { etag: string }>();
  let n = 0;
  const plain = (v: unknown) => String(v ?? "").replace(/^'/, "");
  const route = (url: URL, init: RequestInit & { bodyText: string }): Response | undefined => {
    const method = init.method ?? "GET";
    let body: Record<string, unknown> = {};
    try {
      body = init.bodyText ? (JSON.parse(init.bodyText) as Record<string, unknown>) : {};
    } catch {
      /* a form body (token refresh) */
    }
    if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/files") {
      if (method === "POST") {
        const f = { id: `f${++n}`, name: String(body.name), mimeType: String(body.mimeType), parents: (body.parents as string[]) ?? ["root"] };
        files.set(f.id, f);
        return Response.json(f);
      }
      const q = url.searchParams.get("q") ?? "";
      const name = /name = '([^']+)'/.exec(q)?.[1];
      const mime = /mimeType = '([^']+)'/.exec(q)?.[1];
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const found = [...files.values()].filter((f) => !f.trashed && (!name || f.name === name) && (!mime || f.mimeType === mime) && (!parent || f.parents.includes(parent)));
      return Response.json({ files: found });
    }
    const file = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (url.hostname === "www.googleapis.com" && file) {
      const f = files.get(decodeURIComponent(file[1]!));
      if (!f) return Response.json({ error: { message: "not found" } }, { status: 404 });
      if (method === "PATCH") {
        f.parents = [url.searchParams.get("addParents")!];
        return Response.json(f);
      }
      return Response.json(f);
    }
    if (url.hostname === "sheets.googleapis.com") {
      if (url.pathname === "/v4/spreadsheets" && method === "POST") {
        const id = `s${++n}`;
        files.set(id, { id, name: (body.properties as { title: string }).title, mimeType: "application/vnd.google-apps.spreadsheet", parents: ["root"] });
        rows.set(id, []);
        return Response.json({ spreadsheetId: id, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit` });
      }
      const m = /^\/v4\/spreadsheets\/([^/]+)\/values\/(.+?)(:append)?$/.exec(decodeURIComponent(url.pathname));
      if (m) {
        const sheet = rows.get(m[1]!)!;
        const values = (body.values as unknown[][] | undefined)?.map((r) => r.map(plain));
        if (m[3]) sheet.push(...values!);
        else if (method === "PUT") {
          const row = Number(/(\d+)/.exec(m[2]!)?.[1] ?? 1);
          sheet[row - 1] = values![0]!;
        } else return Response.json({ values: sheet });
        return Response.json({});
      }
    }
    if (url.hostname === "www.googleapis.com" && url.pathname === "/calendar/v3/calendars" && method === "POST") return Response.json({ id: "sig" });
    const ev = /^\/calendar\/v3\/calendars\/sig\/events(?:\/([^/]+))?$/.exec(url.pathname);
    if (url.hostname === "www.googleapis.com" && ev) {
      const id = ev[1] ? decodeURIComponent(ev[1]) : String(body.id);
      if (method === "GET" && !ev[1]) return Response.json({ items: [...events.values()] });
      if (method === "PUT" || method === "POST") {
        events.set(id, { ...body, id, etag: `e${++n}` });
        return Response.json(events.get(id));
      }
      if (method === "DELETE") {
        events.delete(id);
        return new Response(null, { status: 204 });
      }
      // An occurrence of a repeating signal: the series' data under its own id.
      const base = events.get(id) ?? events.get(id.split("_")[0]!);
      if (!base) return Response.json({ error: { message: "not found" } }, { status: 404 });
      const have = events.get(id) ?? { ...base, id, etag: `${base.etag}-${id}` };
      if (method === "PATCH") {
        const ifMatch = (init.headers as Record<string, string> | undefined)?.["if-match"];
        if (ifMatch && ifMatch !== have.etag) return Response.json({ error: { message: "precondition" } }, { status: 412 });
        events.set(id, { ...have, extendedProperties: body.extendedProperties, etag: `e${++n}` });
        return Response.json(events.get(id));
      }
      return Response.json(have);
    }
    if (url.hostname === "gmail.googleapis.com" && url.pathname.endsWith("/trash")) return Response.json({});
    return undefined;
  };
  return { files, rows, events, route };
}

async function setUp(over: { p?: string } = { p: "ok" }) {
  await connectGoogle({ scope: FULL });
  const google = fakeGoogle();
  const calls = mockFetch([google.route]);
  const { env } = testEnv();
  await saveOwnerSettings(env, { ...(await loadOwnerSettings(env)), ...over });
  return { env, google, calls };
}

/** Google Calendar's reminder email for an event of the signal calendar. */
function reminderEmail(eventId: string): GMessage {
  const eid = Buffer.from(`${eventId} sig`).toString("base64url");
  return {
    id: "m1",
    threadId: "t1",
    payload: {
      headers: [
        { name: "From", value: "Google Calendar <calendar-notification@google.com>" },
        { name: "Subject", value: "Notification: 🔔 call" },
      ],
      body: { data: Buffer.from(`https://calendar.google.com/calendar/event?eid=${eid}`).toString("base64url") },
    },
  } as unknown as GMessage;
}

describe("notes: one sheet on the owner's Drive", () => {
  it("the first note makes the folder «AI-secretary» and the sheet «Нотатки», and says so once", async () => {
    const { env, google, calls } = await setUp();
    const first = await addNote(env, { text: "Ідея: звіт по пʼятницях" }, NOW);
    const folder = [...google.files.values()].find((f) => f.name === "AI-secretary")!;
    const sheet = [...google.files.values()].find((f) => f.name === "Нотатки")!;
    expect(sheet.parents).toEqual([folder.id]);
    expect(first.url).toContain(sheet.id);
    expect((await loadOwnerSettings(env)).nt).toBe(sheet.id);
    const told = tgCalls(calls, "sendMessage").filter((m) => String(m.text).includes("📒"));
    expect(told).toHaveLength(1);
    expect(String(told[0]!.text)).toContain("папку «AI-secretary»");
    expect(JSON.stringify(told[0]!.reply_markup)).toContain(sheet.id);
    // Written as text, the header first.
    expect(google.rows.get(sheet.id)![0]).toEqual(["ID", "Створено", "Тип", "Текст", "Нагадати", "Повтор", "Статус", "Оновлено"]);
    expect(google.rows.get(sheet.id)![1]).toMatchObject({ 2: "нотатка", 3: "Ідея: звіт по пʼятницях", 6: "активна" });
    await addNote(env, { text: "Купити папір", kind: "задача" }, NOW);
    expect(tgCalls(calls, "sendMessage").filter((m) => String(m.text).includes("📒"))).toHaveLength(1);
    expect((await readNotes(env, sheet.id)).map((n) => n.text)).toEqual(["Ідея: звіт по пʼятницях", "Купити папір"]);
  });

  it("a sheet the owner deleted is made anew — and the owner is told again", async () => {
    const { env, google, calls } = await setUp();
    await addNote(env, { text: "раз" }, NOW);
    const old = (await loadOwnerSettings(env)).nt!;
    google.files.get(old)!.trashed = true;
    await addNote(env, { text: "два" }, NOW);
    expect((await loadOwnerSettings(env)).nt).not.toBe(old);
    const told = tgCalls(calls, "sendMessage").filter((m) => String(m.text).includes("📒"));
    expect(told).toHaveLength(2);
    expect(String(told[1]!.text)).toContain("не знайшов");
  });

  it("the agent's tools never delete; without the Drive permission they say how to fix it", async () => {
    const { env } = testEnv();
    expect(notesTools(env).map((t) => t.spec.name).join(" ")).not.toMatch(/delete|trash|remove|clear/);
    await connectGoogle({ scope: GMAIL_SCOPE });
    mockFetch([]);
    const add = notesTools(env).find((t) => t.spec.name === "note_add")!;
    expect(JSON.stringify(await add.run({ text: "x" }))).toContain("Перепідключіть Google");
  });
});

describe("note reminders: Google as the clock, Telegram with buttons", () => {
  it("a reminder is a signal with an email at its minute; a repeating one is a series", async () => {
    const { env, google } = await setUp();
    const at = new Date(NOW + 3600_000);
    const once = await addNote(env, { text: "Подзвонити в банк", remindAt: at }, NOW);
    expect(once.reminder).toBe("set");
    expect(once.note.kind).toBe("нагадування");
    const signal = google.events.get(shadowId(`note:${once.note.id}`))!;
    expect(signal).toMatchObject({ reminders: { overrides: [{ method: "email", minutes: 0 }] }, extendedProperties: { private: { aisFor: `note:${once.note.id}` } } });
    expect(signal.recurrence).toBeUndefined();
    const weekly = await addNote(env, { text: "Звіт", remindAt: at, repeat: "weekly" }, NOW);
    expect(google.events.get(shadowId(`note:${weekly.note.id}`))!.recurrence).toEqual(["RRULE:FREQ=WEEKLY"]);
    // A time already gone gets no signal.
    expect((await addNote(env, { text: "вчора", remindAt: new Date(NOW - 3600_000) }, NOW)).reminder).toBe("past");
  });

  it("the signal's email brings the reminder once, with ✅ / ⏰ / 📅; ✅ marks it done and the signal goes", async () => {
    const { env, google, calls } = await setUp();
    const { note } = await addNote(env, { text: "Подзвонити в банк", remindAt: new Date(NOW + 60_000) }, NOW);
    const id = shadowId(`note:${note.id}`);
    expect(await handleReminderEmail(env, reminderEmail(id), NOW + 60_000)).toBe(true);
    resetInstance(); // another copy of the bot with the same email
    await connectGoogle({ scope: FULL });
    await saveOwnerSettings(env, { p: "ok", sc: "sig", nt: (await loadOwnerSettings(env)).nt ?? [...google.rows.keys()][0] });
    await handleReminderEmail(env, reminderEmail(id), NOW + 60_000);
    const sent = tgCalls(calls, "sendMessage").filter((m) => String(m.text).includes("🔔"));
    expect(sent).toHaveLength(1);
    expect(String(sent[0]!.text)).toContain("Подзвонити в банк");
    expect(JSON.stringify(sent[0]!.reply_markup)).toContain(`nt:done:${note.id}`);
    expect(JSON.stringify(sent[0]!.reply_markup)).toContain(`nt:tmr:${note.id}`);

    const done = await noteButton(env, "done", note.id, NOW + 120_000);
    expect(done!.html).toContain("✅ Зроблено");
    const sheet = (await loadOwnerSettings(env)).nt!;
    expect((await readNotes(env, sheet))[0]!.status).toBe("зроблено");
    expect(google.events.has(id)).toBe(false);
  });

  it("⏰ moves a one-off reminder an hour on; for a repeating one it adds a one-off and keeps the series", async () => {
    const { env, google } = await setUp();
    const { note } = await addNote(env, { text: "Вода", remindAt: new Date(NOW + 60_000) }, NOW);
    const later = await noteButton(env, "hour", note.id, NOW + 60_000);
    expect(later!.html).toContain("⏰ Нагадаю о 10:01");
    expect((await readNotes(env, (await loadOwnerSettings(env)).nt!))[0]!.remindAt).toBe("2026-10-05 10:01");
    const rep = await addNote(env, { text: "Зарядка", remindAt: new Date(NOW + 60_000), repeat: "daily" }, NOW);
    await noteButton(env, "tmr", rep.note.id, NOW + 60_000);
    expect(google.events.get(shadowId(`note:${rep.note.id}`))!.recurrence).toEqual(["RRULE:FREQ=DAILY"]);
    expect(google.events.has(shadowId(`note:${rep.note.id}~s`))).toBe(true);
  });

  it("a full signal sync (meetings, morning report) never removes note reminders", async () => {
    const { env, google } = await setUp();
    const { note } = await addNote(env, { text: "Вода", remindAt: new Date(NOW + 3600_000) }, NOW);
    await syncSignals(env, "sig", [], [], true, NOW);
    expect(google.events.has(shadowId(`note:${note.id}`))).toBe(true);
  });
});

describe("notes in the morning report and in routing", () => {
  const n = (over: Partial<Note>): Note => ({ id: "n1", created: "", kind: "нагадування", text: "x", remindAt: "2026-10-05 09:00", repeat: "", status: "активна", updated: "", row: 2, ...over });

  it("a reminder falls on its day; a repeating one by its rule", () => {
    expect(remindsOn(n({}), "2026-10-05")).toBe(true);
    expect(remindsOn(n({}), "2026-10-06")).toBe(false);
    expect(remindsOn(n({ repeat: "daily" }), "2026-10-09")).toBe(true);
    expect(remindsOn(n({ repeat: "weekdays" }), "2026-10-10")).toBe(false); // Saturday
    expect(remindsOn(n({ repeat: "weekly" }), "2026-10-12")).toBe(true);
    expect(remindsOn(n({ repeat: "weekly" }), "2026-10-13")).toBe(false);
    expect(remindsOn(n({ repeat: "monthly" }), "2026-11-05")).toBe(true);
    expect(remindsOn(n({ status: "зроблено" }), "2026-10-05")).toBe(false);
  });

  it("today's reminders, open tasks and — on Monday — the week; nothing before the sheet exists", async () => {
    const { env } = await setUp();
    expect(await notesDigest(env, NOW)).toEqual([]);
    await addNote(env, { text: "Подзвонити в банк", remindAt: new Date(NOW + 3600_000) }, NOW);
    await addNote(env, { text: "Купити папір", kind: "задача" }, NOW);
    const block = (await notesDigest(env, NOW)).join("\n");
    expect(block).toContain("10:00 — Подзвонити в банк");
    expect(block).toContain("Відкриті задачі (1)");
    expect(block).toContain("За тиждень:");
  });

  it("notes words go to the notes agent; a meeting, or «додай нотатку» to a meeting, stays in the calendar", () => {
    const route = (text: string, replyRef?: string) => routeByKeywords({ chatId: OWNER, inputType: "text", text, replyRef }, false);
    expect(route("нагадай мені завтра о 9 подзвонити в банк")).toBe("notes_agent");
    expect(route("запиши ідею: розсилка клієнтам")).toBe("notes_agent");
    expect(route("що я записував про звіт?")).toBe("notes_agent");
    expect(route("постав зустріч з Іваном завтра о 14")).toBe("calendar_agent");
    expect(route("додай нотатку: взяти договір", "eventId: e1")).toBe("calendar_agent");
    expect(route("перенеси на вечір", "noteId: n1")).toBe("notes_agent");
  });
});

describe("the whole way: a message → the notes agent → the sheet", () => {
  it("«нагадай мені…» goes to the notes agent: a 📋 preview first, written and the reminder set only after «так»", async () => {
    // Without the hidden memory folder: the conversation stays in the instance (this fake Drive keeps no memory file).
    await connectGoogle({ scope: FULL.replace(" https://www.googleapis.com/auth/drive.appdata", "") });
    const google = fakeGoogle();
    const seen: LlmRequest[] = [];
    const add = () => llmTools(["note_add", { text: "Подзвонити в банк", remindAt: "2099-10-06T09:00:00+03:00" }]);
    const calls = mockFetch([
      google.route,
      openRouter((req) => {
        const last = req.messages.at(-1)!;
        if (last.role !== "tool") return add();
        // Refused without «так» → the preview; done after «так» → the short answer.
        return String(last.content).includes("НЕ виконано")
          ? llmText("📋 <b>Записати в нотатки?</b>\n📝 Подзвонити в банк\n⏰ 06.10 09:00\nПідтверджуєте? (так / змінити)")
          : llmText("⏰ Нагадаю 6 жовтня о 09:00: подзвонити в банк");
      }, seen),
    ]);
    const { env, jobs } = testEnv();
    await saveOwnerSettings(env, { ...(await loadOwnerSettings(env)), p: "ok" });
    const say = (id: number, text: string) =>
      handleUpdate(env, { update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: OWNER, type: "private" }, from: { id: OWNER, is_bot: false, first_name: "О" }, text } });
    await say(5, "нагадай мені 6 жовтня о 9 подзвонити в банк");
    await runJobs(env, jobs);
    expect(seen[0]!.tools!.map((t) => t.function.name)).toContain("note_add");
    // Nothing written yet: only the preview, with ✅ / ✏️.
    expect([...google.rows.values()].every((rows) => rows.length <= 1)).toBe(true);
    expect(google.events.size).toBe(0);
    const preview = tgCalls(calls, "sendMessage").at(-1)!;
    expect(String(preview.text)).toContain("📋");
    expect(JSON.stringify(preview.reply_markup)).toContain("ok:yes");
    await say(6, "так");
    await runJobs(env, jobs);
    const sheet = [...google.rows.values()][0]!;
    expect(sheet[1]).toMatchObject({ 3: "Подзвонити в банк", 4: "2099-10-06 09:00" });
    expect(google.events.size).toBe(1);
    expect(String(tgCalls(calls, "sendMessage").at(-1)!.text)).toContain("Нагадаю");
  });

});

describe("after an update: the sheet is made at once; /notes shows what is there", () => {
  it("the folder and the sheet are made right away and the owner is told — once; not without the Drive permission", async () => {
    const { env, google, calls } = await setUp();
    await ensureNotesSheet(env);
    await ensureNotesSheet(env);
    expect([...google.files.values()].map((f) => f.name).sort()).toEqual(["AI-secretary", "Нотатки"]);
    expect(tgCalls(calls, "sendMessage").filter((m) => String(m.text).includes("папку «AI-secretary»"))).toHaveLength(1);
  });

  it("nothing happens without the Drive permission", async () => {
    await connectGoogle({ scope: GMAIL_SCOPE });
    const calls = mockFetch([]);
    const { env } = testEnv();
    await ensureNotesSheet(env);
    expect(tgCalls(calls, "sendMessage")).toEqual([]);
  });

  it("lists: all, upcoming reminders, to-dos, done; the link; the morning report's block on / off", async () => {
    const { env } = await setUp();
    await addNote(env, { text: "Ідея розсилки" }, NOW);
    await addNote(env, { text: "Купити папір", kind: "задача" }, NOW);
    await addNote(env, { text: "Подзвонити в банк", remindAt: new Date(NOW + 3600_000) }, NOW);
    const all = await notesView(env, "all", false, NOW);
    expect(all.html).toContain("Активних: <b>3</b>");
    expect(all.html).toContain("1. Подзвонити в банк — ⏰ 05.10 10:00");
    expect(JSON.stringify(all.keyboard)).toContain("docs.google.com/spreadsheets");
    expect((await notesView(env, "rem", false, NOW)).html).not.toContain("Ідея розсилки");
    expect((await notesView(env, "todo", false, NOW)).html).toContain("1. Купити папір");
    expect((await notesView(env, "done", false, NOW)).html).toContain("Зроблених ще немає");
    expect((await notesView(env, "all", true, NOW)).keyboard.at(-1)).toEqual([{ text: "⬅️ Готово", callback_data: "set:back" }]);
    const on = (await loadDigestChoice(env)).blocks.includes("notes");
    await handleNotesButton(env, "nm:dg:all", "cb", OWNER, 1);
    expect((await loadDigestChoice(env)).blocks.includes("notes")).toBe(!on);
  });
});
