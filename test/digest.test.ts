import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDigest, digestSignals, meetingsBlock } from "../src/google/digest";
import { saveOwnerSettings } from "../src/google/oauth";
import type { Meeting } from "../src/google/sync";
import { connectGoogle, mockFetch, resetInstance, testEnv, tgCalls } from "./helpers";

beforeEach(() => resetInstance());
afterEach(() => vi.restoreAllMocks());

const H = 3600_000;
// 2026-10-01 05:00 UTC = 08:00 Kyiv
const NOW = Date.parse("2026-10-01T05:00:00Z");
const meeting = (title: string, startH: number, endH: number, extra: Partial<Meeting> = {}): Meeting => ({
  title,
  description: null,
  start_at: NOW + startH * H,
  end_at: NOW + endH * H,
  location: null,
  meet_url: null,
  html_link: null,
  attendees: [],
  organizer_email: null,
  ...extra,
});

describe("the morning report", () => {
  it("meetings with guests, link, overlaps and the free windows between them", () => {
    const lines = meetingsBlock([
      meeting("Планування", 1, 2, { attendees: [{ email: "ann@x.ua", name: "Анна", response: null }], meet_url: "https://meet.google.com/a" }),
      meeting("Дзвінок", 1.5, 2.5),
      meeting("Обід з клієнтом", 5, 6, { location: "Кафе" }),
    ]).join("\n");
    expect(lines).toContain("<b>09:00–10:00</b> Планування");
    expect(lines).toContain("👥 Анна");
    expect(lines).toContain('<a href="https://meet.google.com/a">Приєднатися</a>');
    expect(lines).toContain("⚠️ Перетинається з «Планування»");
    expect(lines).toContain("📍 Кафе");
    expect(lines).toContain("🟢 <b>Вільні вікна:</b> 10:30–13:00");
  });

  it("its signal at the owner's time for today and tomorrow; none when it is off", () => {
    const s = digestSignals({ on: true, time: 540, blocks: [] }, NOW);
    expect(s.map((x) => [x.key, new Date(x.start).toISOString()])).toEqual([
      ["digest:2026-10-01", "2026-10-01T06:00:00.000Z"],
      ["digest:2026-10-02", "2026-10-02T06:00:00.000Z"],
    ]);
    expect(s[0]!.minutes).toEqual([0]);
    expect(digestSignals({ on: false, time: 540, blocks: [] }, NOW)).toEqual([]);
  });

  it("invitations waiting for an answer come with ✅ / ❌; tomorrow's first meeting; silent on an empty day", async () => {
    await connectGoogle();
    const at = (h: number) => new Date(NOW + h * H).toISOString();
    let items: unknown[] = [
      { id: "m1", status: "confirmed", summary: "Стендап", start: { dateTime: at(2) }, end: { dateTime: at(3) } },
      {
        id: "inv1",
        status: "confirmed",
        summary: "Демо",
        organizer: { email: "boss@x.ua", displayName: "Бос" },
        attendees: [{ email: "me@x.ua", self: true, responseStatus: "needsAction" }],
        start: { dateTime: at(30) },
        end: { dateTime: at(31) },
      },
    ];
    mockFetch([(url) => (url.hostname === "www.googleapis.com" && url.pathname.includes("/calendar/") ? Response.json({ items }) : undefined)]);
    const { env } = testEnv();
    await saveOwnerSettings(env, { dg: { b: ["inv", "tmr"] } });
    const d = (await buildDigest(env, NOW))!;
    expect(d.text).toContain("Стендап");
    expect(d.text).toContain("📨 <b>Чекають на відповідь (1):</b>");
    expect(d.text).toContain("(від Бос)");
    expect(d.text).toContain("🌅 <b>Завтра:</b> перша зустріч о 14:00 — Демо");
    expect(d.keyboard).toEqual([[{ text: "✅ Демо", callback_data: "accept:inv1" }, { text: "❌", callback_data: "decline:inv1" }]]);

    items = [];
    expect(await buildDigest(env, NOW)).toBeNull();
    await saveOwnerSettings(env, { dg: { b: ["empty"] } });
    expect((await buildDigest(env, NOW))!.text).toContain("Сьогодні зустрічей немає");
  });
});

describe("the report's safety net", () => {
  it("after its time (Google's signal did not bring it) the next wake-up sends it — once, claimed on its signal", async () => {
    await connectGoogle();
    const { sendDueDigest } = await import("../src/google/digest");
    const { shadowId } = await import("../src/google/signals");
    const at = (h: number) => new Date(NOW + h * H).toISOString();
    const signal: Record<string, unknown> = { id: shadowId("digest:2026-10-01"), etag: '"1"', status: "confirmed", extendedProperties: { private: { aisFor: "digest:2026-10-01" } } };
    const calls = mockFetch([
      (url, init) => {
        if (url.hostname !== "www.googleapis.com" || !url.pathname.includes("/calendar/")) return undefined;
        const path = decodeURIComponent(url.pathname);
        if (path.includes("/sig@x/events/")) {
          if (init.method === "PATCH") {
            signal.extendedProperties = JSON.parse(init.bodyText).extendedProperties;
            return Response.json(signal);
          }
          return Response.json(signal);
        }
        return Response.json({ items: [{ id: "m1", status: "confirmed", summary: "Стендап", start: { dateTime: at(2) }, end: { dateTime: at(3) } }] });
      },
    ]);
    const { env } = testEnv();
    // 08:00 was the time; it is 08:40 now.
    await saveOwnerSettings(env, { p: "ok", sc: "sig@x", dg: { t: 480, b: [] } });
    expect(await sendDueDigest(env, NOW + 40 * 60_000)).toBe(true);
    expect(String(tgCalls(calls, "sendMessage").at(-1)!.text)).toContain("Доброго ранку");
    expect((signal.extendedProperties as { private: Record<string, string> }).private.aisSent).toBe("1");
    resetInstance();
    await connectGoogle();
    await saveOwnerSettings(env, { p: "ok", sc: "sig@x", dg: { t: 480, b: [] } });
    expect(await sendDueDigest(env, NOW + 50 * 60_000)).toBe(false);
    // Not before its time, not 3 hours late.
    expect(await sendDueDigest(env, NOW - 10 * 60_000)).toBe(false);
  });

  it("a day without meetings still gets its report by default", async () => {
    await connectGoogle();
    mockFetch([(url) => (url.hostname === "www.googleapis.com" && url.pathname.includes("/calendar/") ? Response.json({ items: [] }) : undefined)]);
    const { env } = testEnv();
    expect((await buildDigest(env, NOW))!.text).toContain("Сьогодні зустрічей немає");
  });
});

describe("the report through Google's signal", () => {
  it("Google's email for the day's signal brings the report once; the email goes to Trash", async () => {
    await connectGoogle();
    const { shadowId } = await import("../src/google/signals");
    const { handleReminderEmail } = await import("../src/google/reminders");
    const sid = shadowId("digest:2026-10-01");
    const signal: Record<string, unknown> = { id: sid, etag: '"1"', status: "confirmed", extendedProperties: { private: { aisFor: "digest:2026-10-01" } } };
    let trashed = 0;
    const calls = mockFetch([
      (url, init) => {
        if (url.hostname === "gmail.googleapis.com") {
          if (url.pathname.endsWith("/trash")) trashed++;
          return Response.json({});
        }
        if (url.hostname !== "www.googleapis.com") return undefined;
        const path = decodeURIComponent(url.pathname);
        if (path.includes(`/sig@x/events/${sid}`)) {
          if (init.method === "PATCH") signal.extendedProperties = JSON.parse(init.bodyText).extendedProperties;
          return Response.json(signal);
        }
        return Response.json({ items: [] });
      },
    ]);
    const { env } = testEnv();
    await saveOwnerSettings(env, { p: "ok", sc: "sig@x" });
    const email = {
      id: "m",
      threadId: "t",
      payload: {
        headers: [
          { name: "From", value: "Google Calendar <calendar-notification@google.com>" },
          { name: "Subject", value: "Сповіщення: ☀️ Ранковий звіт" },
        ],
        body: { data: Buffer.from(`https://calendar.google.com/calendar/event?eid=${Buffer.from(`${sid} sig@x`).toString("base64url")}`).toString("base64url") },
      },
    } as never;
    expect(await handleReminderEmail(env, email, NOW)).toBe(true);
    expect(await handleReminderEmail(env, email, NOW)).toBe(true);
    const reports = tgCalls(calls, "sendMessage").filter((m) => String(m.text).includes("Доброго ранку"));
    expect(reports.length).toBe(1);
    expect(trashed).toBe(2);
  });
});
