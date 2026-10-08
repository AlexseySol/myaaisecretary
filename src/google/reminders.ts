import { reminderMarks } from "../bot/settings";
import type { Env } from "../env";
import { DAY, formatRange, kyivLocalToDate, kyivParts, MINUTE } from "../lib/time";
import { firstTime } from "../session";
import { esc, Telegram } from "../telegram/api";
import { hiddenData } from "../telegram/hidden";
import { Calendar, type GEvent } from "./calendar";
import { loadOwnerSettings, type OwnerSettings } from "./oauth";
import { wakeReady } from "./pubsub";
import { digestSignals, loadDigestChoice, sendDigestOnce } from "./digest";
import { DIGEST_PREFIX, NOTE_PREFIX, type Signal, signalCalendar, signalEvent, syncSignals } from "./signals";
import { sendNoteReminder } from "./notes";
import { type GMessage, Gmail, toMailMessage } from "./gmail";
import { type EventRef, eventToChange, invitationButtons, listMeetings, type Meeting } from "./sync";

/**
 * Private event property: "start:minutes" of the last reminder sent (e.g. "1790000000000:10"). A moved meeting has
 * another start, so it is reminded again.
 */
export const PROP_REMINDED = "aisReminded";
/** An invitation the owner has not answered: asked once to answer it instead of a reminder («<start>»). */
const PROP_ASKED = "aisAsked";

/** The owner is a guest who has not answered the invitation yet. */
const unanswered = (ev: GEvent) => !ev.organizer?.self && ev.attendees?.find((a) => a.self)?.responseStatus === "needsAction";

/** A pinger every 5 minutes rarely hits the exact minute: a reminder may go out this much early. */
const EARLY = 2 * MINUTE;

/**
 * Which reminder is due now: the nearest REMINDER_MINUTES mark already reached, if it was not sent yet. With
 * [30, 10]: 27 min left → 30; 8 min left → 10; a meeting added 5 min before its start gets just the 10-minute one.
 */
export function dueReminder(marks: number[], left: number, lastSent: number | null): number | null {
  const reached = marks.filter((m) => left <= m * MINUTE + EARLY);
  if (!reached.length) return null;
  const mark = Math.min(...reached);
  return lastSent !== null && lastSent <= mark ? null : mark;
}

/**
 * Telegram reminders REMINDER_MINUTES (30 and 10 by default) before each meeting — plain code, no AI. Called by
 * /api/cron/reminders every 5 minutes (any free pinger such as cron-job.org, or a Vercel Pro cron). Nothing is
 * stored: a reminded event gets a private property.
 */
export interface ReminderCheck {
  marks: number[];
  sent: number;
  /** Meetings in the reminder window, for the check's answer: title, minutes left, what was sent. */
  upcoming: { title: string; minutesLeft: number; sentNow: number | null }[];
}

export async function sendReminders(env: Env, now = Date.now()): Promise<number> {
  return (await checkReminders(env, now)).sent;
}

/** Sends the due reminders and says what it saw — /api/cron/reminders shows this, so a pinger's log explains itself. */
export async function checkReminders(env: Env, now = Date.now()): Promise<ReminderCheck> {
  // The owner's choice from /settings, else REMINDER_MINUTES.
  const marks = await reminderMarks(env);
  const check: ReminderCheck = { marks, sent: 0, upcoming: [] };
  if (!marks.length) return check;
  const cal = new Calendar(env);
  const window = Math.max(...marks) * MINUTE + EARLY;
  const page = await cal.listEvents({
    singleEvents: "true",
    orderBy: "startTime",
    timeMin: new Date(now).toISOString(),
    timeMax: new Date(now + window).toISOString(),
    maxResults: "50",
  });
  const tg = new Telegram(env);
  for (const ev of page.items) {
    const change = eventToChange(ev);
    if (change.kind !== "upsert") continue;
    const m = change.meeting;
    if (m.start_at < now || m.start_at > now + window) continue;
    const props = ev.extendedProperties?.private ?? {};
    const [sentFor, sentMark] = (props[PROP_REMINDED] ?? "").split(":");
    // Before marks existed the property held the start only: that reminder counts as the first (largest) mark.
    const lastSent = sentFor === String(m.start_at) ? Number(sentMark ?? Math.max(...marks)) : null;
    const mark = dueReminder(marks, m.start_at - now, lastSent);
    const seen = { title: m.title ?? "зустріч", minutesLeft: Math.round((m.start_at - now) / MINUTE), sentNow: null as number | null };
    check.upcoming.push(seen);
    if (mark === null) continue;
    if (await sendReminder(env, cal, tg, ev, m, mark, now)) {
      check.sent++;
      seen.sentNow = mark;
    }
  }
  return check;
}

/** One reminder, claimed first on the event so it goes out once whatever woke the bot (a reminder email, a check). */
async function sendReminder(env: Env, cal: Calendar, tg: Telegram, ev: GEvent, m: Meeting, mark: number, now: number): Promise<boolean> {
  if (unanswered(ev)) return askToAnswer(env, cal, tg, ev, m, now);
  if (!firstTime(`remind:${ev.id}:${m.start_at}:${mark}`, DAY)) return false;
  const props = ev.extendedProperties?.private ?? {};
  // Recurring instances are not marked (that would turn each into an exception); the instance memory covers them.
  if (!ev.recurringEventId && !(await cal.claimPrivate(ev, { ...props, [PROP_REMINDED]: `${m.start_at}:${mark}` }))) return false;
  const text = `⏰ <b>Через ${inTime(m.start_at - now)}</b> — <b>${esc(m.title ?? "зустріч")}</b>\n\n${meetingCard(m)}`;
  await tg.send(env.OWNER_TELEGRAM_ID, hiddenData({ k: "ev", id: ev.id } satisfies EventRef) + text);
  return true;
}

/** «28 хв», «1 год», «1 год 20 хв». */
function inTime(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes} хв`;
  const h = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${h} год ${rest} хв` : `${h} год`;
}

const SHOWN_GUESTS = 4;

/** When, where (a tappable Meet / Zoom link) and who — the body of a reminder. */
function meetingCard(m: Meeting): string {
  const lines = [`🕒 ${esc(formatRange(new Date(m.start_at), new Date(m.end_at)))}`];
  if (m.meet_url) lines.push(`🎥 <a href="${esc(m.meet_url)}">${/zoom\./i.test(m.meet_url) ? "Приєднатися в Zoom" : "Приєднатися в Google Meet"}</a>`);
  if (m.location) lines.push(`📍 ${esc(m.location)}`);
  if (m.attendees.length) {
    const names = m.attendees.slice(0, SHOWN_GUESTS).map((a) => esc(a.name ?? a.email));
    const more = m.attendees.length - SHOWN_GUESTS;
    lines.push(`👥 ${names.join(", ")}${more > 0 ? ` і ще ${more}` : ""}`);
  }
  return lines.join("\n");
}

/**
 * A meeting the owner has not accepted gets no reminder: once, at its first reminder time, the bot asks to answer it
 * (✅ / ❌). Accepted, it gets its later reminders as usual; declined, none.
 */
async function askToAnswer(env: Env, cal: Calendar, tg: Telegram, ev: GEvent, m: Meeting, now: number): Promise<boolean> {
  if (!firstTime(`ask:${ev.id}:${m.start_at}`, DAY)) return false;
  const props = ev.extendedProperties?.private ?? {};
  if (props[PROP_ASKED] === String(m.start_at)) return false;
  if (!ev.recurringEventId && !(await cal.claimPrivate(ev, { ...props, [PROP_ASKED]: String(m.start_at) }))) return false;
  const text =
    `❓ <b>Через ${inTime(m.start_at - now)}</b> — <b>${esc(m.title ?? "зустріч")}</b>\n` +
    `Ви ще не підтвердили цю зустріч.\n\n${meetingCard(m)}\n\n<i>Нагадування прийдуть, коли приймете.</i>`;
  const keyboard = invitationButtons(ev.id);
  await tg.send(env.OWNER_TELEGRAM_ID, hiddenData({ k: "ev", id: ev.id } satisfies EventRef) + text, keyboard ? { keyboard } : {});
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Google itself as the clock: no cron, no outside service.
//
// Every upcoming meeting gets the owner's own Google reminders "by email" at the chosen minutes. At that minute
// Google sends the email; Gmail pushes the bot at once (google/pubsub.ts); the bot recognises the calendar's reminder
// email, sends the Telegram reminder and moves the email to Trash.

/** Where reminders go: Telegram (t) and Google Calendar's own notifications (c). Both by default. */
export interface Channels {
  t: boolean;
  c: boolean;
}

/** Every reminder goes to both (the owner asked for no channel buttons; an older choice in `n` is ignored). */
export async function reminderChannels(_env: Env): Promise<Channels> {
  return { t: true, c: true };
}

/** Whether new emails are sent to the chat (/settings → «📧 Нова пошта в бот»); reminder signals always work. */
export async function mailNotices(env: Env): Promise<boolean> {
  return (await loadOwnerSettings(env).catch((): OwnerSettings => ({}))).ml ?? true;
}

const emails = (marks: number[]) => marks.slice(0, 5).map((minutes) => ({ method: "email", minutes }));
const popups = (marks: number[]) => marks.slice(0, 5).map((minutes) => ({ method: "popup", minutes }));

/**
 * The owner's reminders on a meeting itself: an email signal per mark for Telegram and a popup per mark for Calendar —
 * right on the meeting, no copy anywhere, while they fit in the 5 places Google allows (the usual 1–2 marks). Only with
 * more marks than that do the Telegram signals move to a shadow in the bot's signal calendar and the meeting keeps the
 * popups. Without the signal calendar the 5 places are shared: email signals first, then the popups nearest the start.
 */
export function desiredReminders(marks: number[], ch: Channels = { t: true, c: true }, signalCalendar = false): NonNullable<GEvent["reminders"]> {
  if (!marks.length) return { useDefault: true };
  if (signalCalendar && !fitsOnMeeting(marks, ch)) return { useDefault: false, overrides: ch.c ? popups(marks) : [] };
  const overrides = ch.t ? emails(marks) : [];
  if (ch.c) for (const m of [...marks].sort((x, y) => x - y)) if (overrides.length < 5) overrides.push({ method: "popup", minutes: m });
  return { useDefault: false, overrides };
}

/** Telegram signals and Calendar popups both fit on the meeting itself (Google allows 5 reminders per event). */
export function fitsOnMeeting(marks: number[], ch: Channels = { t: true, c: true }): boolean {
  return (ch.t ? marks.length : 0) + (ch.c ? marks.length : 0) <= 5;
}

const reminderKey = (r: GEvent["reminders"]) =>
  r?.useDefault ? "default" : JSON.stringify([...(r?.overrides ?? [])].map((o) => `${o.method}:${o.minutes}`).sort());

/**
 * Puts the owner's reminders on the upcoming meetings (next 8 days; a recurring series once, on its master) and keeps
 * their Telegram signals in the bot's signal calendar in step: new or moved meetings get a shadow, cancelled ones lose
 * it. `events` = only these (a calendar push); none = the whole coming week (also removes stale shadows). Only
 * changes what differs. Returns how many writes were made.
 */
export async function applyEmailReminders(env: Env, events?: GEvent[], now = Date.now()): Promise<number> {
  const marks = await reminderMarks(env);
  const ch = await reminderChannels(env);
  const cal = new Calendar(env);
  const list =
    events ??
    (
      await cal.listEvents({
        singleEvents: "true",
        orderBy: "startTime",
        timeMin: new Date(now).toISOString(),
        timeMax: new Date(now + 8 * DAY).toISOString(),
        maxResults: "250",
      })
    ).items;
  // Telegram signals need Google to wake the bot; Calendar notifications work without it.
  const awake = await wakeReady(env);
  const telegram = ch.t && marks.length > 0 && awake;
  // The morning report at the owner's time is a signal too.
  const morning = awake ? digestSignals(await loadDigestChoice(env), now) : [];
  const signals = telegram || morning.length ? await signalCalendar(env) : null;
  const want = desiredReminders(marks, { t: telegram, c: ch.c }, !!signals);
  const done = new Set<string>();
  const upcoming: Signal[] = [];
  let changed = 0;
  for (const ev of list) {
    const change = eventToChange(ev);
    if (change.kind !== "upsert" || change.meeting.end_at < now) continue;
    // A shadow copy only when the signals do not fit on the meeting itself (3+ marks).
    if (telegram && !fitsOnMeeting(marks, { t: telegram, c: ch.c })) upcoming.push({ key: ev.id, summary: `🔔 ${ev.summary ?? "зустріч"}`, start: change.meeting.start_at, end: change.meeting.end_at, minutes: marks });
    const target = ev.recurringEventId ?? ev.id;
    if (done.has(target)) continue;
    done.add(target);
    if (reminderKey(ev.reminders) === reminderKey(want)) continue;
    await cal
      .setReminders(target, want)
      .then(() => changed++)
      .catch((err) => console.warn("gcal: cannot set reminders", target, err instanceof Error ? err.message : err));
  }
  if (signals) {
    const gone = list.filter((ev) => eventToChange(ev).kind !== "upsert").map((ev) => ev.id);
    changed += await syncSignals(env, signals, [...upcoming, ...morning], gone, !events, now).catch((err) => {
      console.warn("signals:", err instanceof Error ? err.message : err);
      return 0;
    });
  }
  return changed;
}

/** All text of an email, every part decoded (the calendar's link with the event id is in there). */
function allText(part: GMessage["payload"]): string {
  if (!part) return "";
  const own = part.body?.data ? Buffer.from(part.body.data, "base64url").toString("utf8") : "";
  return [own, ...(part.parts ?? []).map(allText)].join("\n");
}

/** Google's emails about an invitation itself (new, changed, cancelled, a guest's answer) — never a reminder. */
const INVITATION_SUBJECT =
  /^(invitation|updated invitation|new event|accepted|declined|tentatively accepted|canceled|cancelled|event canceled|запрошення|оновлене запрошення|нова подія|прийнято|відхилено|скасовано|приглашение|обновленное приглашение|новое мероприятие|принято|отклонено|отменено|отменённое мероприятие)(?=$|[\s:])/i;

const REMINDER_SUBJECT = /^(notification|reminder|уведомление|напоминание|сповіщення|нагадування|powiadomienie|benachrichtigung)(?=$|[\s:])/i;

/** The event id from a Google Calendar email: its links carry eid = base64("<event id> <calendar>"). */
export function eventIdFromEmail(m: GMessage): string | null {
  for (const eid of allText(m.payload).matchAll(/[?&]eid=([A-Za-z0-9_-]+)/g)) {
    const decoded = Buffer.from(eid[1]!, "base64url").toString("utf8");
    const id = decoded.split(" ")[0];
    if (id && /^[a-z0-9_]+$/i.test(id)) return id;
  }
  return null;
}

/**
 * A new email that is the calendar's own reminder: sends the Telegram reminder instead of a "new mail" notice and
 * moves the email to Trash. False when it is any other email.
 */
export async function handleReminderEmail(env: Env, m: GMessage, now = Date.now()): Promise<boolean> {
  const mail = toMailMessage(m);
  if (!/calendar-notification@google\.com/i.test(mail.from)) return false;
  const id = eventIdFromEmail(m);
  if (!id) return false;
  // A signal (the shadow in the bot's signal calendar) stands for the owner's meeting — whatever the subject's language.
  const signal = await signalEvent(env, id);
  const target = signal?.ev.extendedProperties?.private?.aisFor ?? null;
  const gmail = new Gmail(env);
  if (target?.startsWith(NOTE_PREFIX) && signal) {
    // A note's reminder (one occurrence of a repeating one has its own id).
    await sendNoteReminder(env, signal.cal.calendarId, id, target, now);
    await gmail.trash(m.id).catch(() => undefined);
    return true;
  }
  if (target?.startsWith(DIGEST_PREFIX) && signal) {
    // One report per day whichever copy of the bot got the email.
    await sendDigestOnce(env, target, now);
    await gmail.trash(m.id).catch(() => undefined);
    return true;
  }
  const cal = new Calendar(env);
  const ev = await cal.getEvent(target ?? id).catch(() => null);
  // The meeting's own email reminder (the bot put it there), a shadow's, or a reminder-looking subject.
  // An invitation email (a change of time, a guest's answer) about such a meeting is mail, not a reminder.
  const subject = mail.subject.trim();
  const ownSignal = !!ev?.reminders?.overrides?.some((o) => o.method === "email") && !INVITATION_SUBJECT.test(subject);
  if (!target && !ownSignal && !REMINDER_SUBJECT.test(subject)) return false;
  const change = ev ? eventToChange(ev) : null;
  if (ev && change?.kind === "upsert" && change.meeting.start_at > now - 5 * MINUTE) {
    const marks = await reminderMarks(env);
    const left = change.meeting.start_at - now;
    // The mark this email stands for: the smallest chosen one not below the time left. None — it is not one of the
    // owner's reminder times (hours ahead): no Telegram reminder for it.
    const mark = marks.filter((x) => left <= x * MINUTE + EARLY).sort((a, b) => a - b)[0];
    if (mark !== undefined) await sendReminder(env, cal, new Telegram(env), ev, change.meeting, mark, now);
  }
  await gmail.trash(m.id).catch(() => undefined);
  return true;
}
