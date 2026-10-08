import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleReminderEmail } from "../src/google/reminders";
import { connectGoogle, mockFetch, resetInstance, testEnv, tg, tgCalls } from "./helpers";

beforeEach(() => resetInstance());
afterEach(() => vi.restoreAllMocks());

const NOW = Date.parse("2026-10-08T08:42:00Z");
const START = NOW + 378 * 60_000;

/** Google's email about event e1, with this subject. */
const mail = (subject: string, id = "m1") =>
  ({
    id,
    threadId: "t",
    payload: {
      headers: [
        { name: "From", value: "Google Calendar <calendar-notification@google.com>" },
        { name: "Subject", value: subject },
      ],
      body: { data: Buffer.from(`https://calendar.google.com/calendar/event?eid=${Buffer.from("e1 o@x.com").toString("base64url")}`).toString("base64url") },
    },
  }) as never;

/** The calendar with event e1 (the bot's email reminders on it), starting at `start`; trashed emails are kept. */
function google(start: number, self: "accepted" | "needsAction" = "accepted") {
  const trashed: string[] = [];
  const patches: unknown[] = [];
  const ev = () => ({
    id: "e1",
    etag: '"1"',
    status: "confirmed",
    summary: "Партнери",
    start: { dateTime: new Date(start).toISOString() },
    end: { dateTime: new Date(start + 3600_000).toISOString() },
    organizer: { email: "boss@x.com" },
    attendees: [{ email: "o@x.com", self: true, responseStatus: self }, { email: "boss@x.com", organizer: true, responseStatus: "accepted" }],
    reminders: { useDefault: false, overrides: [{ method: "email", minutes: 30 }, { method: "popup", minutes: 30 }] },
  });
  const calls = mockFetch([
    (url, init) => {
      if (url.hostname === "gmail.googleapis.com" && url.pathname.endsWith("/trash")) {
        trashed.push(url.pathname);
        return Response.json({});
      }
      if (url.hostname === "www.googleapis.com" && url.pathname.includes("/events/e1")) {
        if (init.method === "PATCH") patches.push(JSON.parse(init.bodyText));
        return Response.json(ev());
      }
      return undefined;
    },
  ]);
  return { trashed, patches, calls };
}

const sent = () => [...tg.messages.values()].filter((m) => /Через|не підтвердили/.test(m.text ?? ""));

describe("Google's emails that are not one of the owner's reminder times", () => {
  it("an invitation update about a meeting with the bot's reminders is mail: no reminder, not trashed", async () => {
    await connectGoogle();
    const g = google(START);
    const { env } = testEnv();
    expect(await handleReminderEmail(env, mail("Updated invitation: Партнери @ Thu Oct 8, 2026 3pm"), NOW)).toBe(false);
    expect(sent()).toHaveLength(0);
    expect(g.trashed).toHaveLength(0);
  });

  it("a reminder email hours before (not a chosen time) sends no «Через 378 хв»", async () => {
    await connectGoogle();
    google(START);
    const { env } = testEnv();
    await handleReminderEmail(env, mail("Notification: Партнери @ Thu Oct 8, 2026 3pm"), NOW);
    expect(sent()).toHaveLength(0);
  });

  it("at a chosen time the reminder comes as before", async () => {
    await connectGoogle();
    google(NOW + 30 * 60_000);
    const { env } = testEnv();
    expect(await handleReminderEmail(env, mail("Notification: Партнери"), NOW)).toBe(true);
    expect(sent().map((m) => m.text)).toEqual([expect.stringContaining("Через 30 хв")]);
  });
});

describe("a meeting the owner has not accepted", () => {
  it("no reminder: once, the bot asks to answer it, with ✅ / ❌", async () => {
    await connectGoogle();
    const g = google(NOW + 30 * 60_000, "needsAction");
    const { env } = testEnv();
    await handleReminderEmail(env, mail("Notification: Партнери"), NOW);
    await handleReminderEmail(env, mail("Notification: Партнери", "m2"), NOW + 20 * 60_000);
    expect(sent()).toHaveLength(1);
    const ask = sent()[0]!;
    expect(ask.text).toContain("не підтвердили");
    expect(ask.text).not.toContain("Через 30 хв:");
    expect(JSON.stringify(tgCalls(g.calls, "sendMessage").at(-1)!.reply_markup)).toContain("accept:e1");
    expect(JSON.stringify(g.patches)).toContain("aisAsked");
  });
});
