import type { Env } from "../env";
import { DAY, formatDay, formatTime, HOUR, kyivParts, MINUTE, parseIsoWithOffset, parseKyivLocal, toKyivDate, toKyivIso, TZ } from "../lib/time";
import { firstTime } from "../session";
import { esc, Telegram } from "../telegram/api";
import { hiddenData } from "../telegram/hidden";
import type { InlineKeyboard } from "../telegram/types";
import { Calendar, type GEvent } from "./calendar";
import { loadOwnerSettings, saveOwnerSettings } from "./oauth";
import { NOTE_PREFIX, shadowId, signalCalendar } from "./signals";

export { NOTE_PREFIX };
import { hasWorkspaceScope, Workspace } from "./workspace";

/**
 * The owner's notes: thoughts, to-dos and personal reminders, in ONE Google Sheet «Нотатки» inside the folder
 * «AI-secretary» on the owner's Drive (scope drive) — the owner can open and edit it by hand; there is no database.
 * Made the first time a note is written; the owner is told once where it is (and again if it is ever gone and made anew).
 *
 * A reminder is a signal in the bot's signal calendar (google/signals.ts): an event at that minute with an email
 * reminder; Google sends the email, Gmail push wakes the bot, the reminder comes to Telegram with ✅ / ⏰ / 📅 buttons.
 * A repeating reminder is a recurring signal. Nothing is ever deleted from the sheet: a note is marked done or archived.
 */

/** A one-off «⏰ through an hour» of a repeating reminder: `note:<id>~s`. */
const SNOOZE = "~s";
export const NOTES_FOLDER = "AI-secretary";
export const NOTES_SHEET = "Нотатки";
const HEADER = ["ID", "Створено", "Тип", "Текст", "Нагадати", "Повтор", "Статус", "Оновлено"];

export const KINDS = ["нотатка", "задача", "нагадування"] as const;
export type NoteKind = (typeof KINDS)[number];
export const REPEATS = { "": "", daily: "щодня", weekdays: "по буднях", weekly: "щотижня", monthly: "щомісяця" } as const;
export type Repeat = keyof typeof REPEATS;
export const STATUSES = ["активна", "зроблено", "архів"] as const;
export type NoteStatus = (typeof STATUSES)[number];

const RRULE: Record<Repeat, string> = {
  "": "",
  daily: "RRULE:FREQ=DAILY",
  weekdays: "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
  weekly: "RRULE:FREQ=WEEKLY",
  monthly: "RRULE:FREQ=MONTHLY",
};

export interface Note {
  id: string;
  created: string;
  kind: NoteKind;
  text: string;
  /** Kyiv local "YYYY-MM-DD HH:MM", or "" without a reminder. */
  remindAt: string;
  repeat: Repeat;
  status: NoteStatus;
  updated: string;
  /** Its row in the sheet (1 = the header). */
  row: number;
}

/** Notes need the full Drive permission (the sheet lives on the owner's Drive). */
export class NotesUnavailable extends Error {}

const sheetUrl = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;
/** "2026-10-03 10:00" in Kyiv time. */
export const localTime = (d: Date) => `${toKyivDate(d)} ${formatTime(d)}`;
/** Everything is written as text (a leading «'»), so Sheets never turns a date or «=…» into something else. */
const cell = (v: string) => (v ? `'${v}` : "");

/** A time the model gave: ISO with an offset, or Kyiv local "YYYY-MM-DDTHH:MM". */
export function parseWhen(value: unknown): Date | null {
  return parseIsoWithOffset(value) ?? parseKyivLocal(value);
}

const repeatOf = (v: string): Repeat => ((Object.keys(REPEATS) as Repeat[]).find((k) => k === v || REPEATS[k] === v) ?? "") as Repeat;

function toRow(n: Omit<Note, "row">): string[] {
  return [n.id, n.created, n.kind, n.text, n.remindAt, REPEATS[n.repeat], n.status, n.updated].map(cell);
}

function fromRow(r: string[], row: number): Note | null {
  const [id = "", created = "", kind = "", text = "", remindAt = "", repeat = "", status = "", updated = ""] = r.map((c) => String(c ?? "").trim());
  if (!id || id === "ID") return null;
  return {
    id,
    created,
    kind: (KINDS as readonly string[]).includes(kind) ? (kind as NoteKind) : "нотатка",
    text,
    remindAt: parseKyivLocal(remindAt) ? remindAt : "",
    repeat: repeatOf(repeat),
    status: (STATUSES as readonly string[]).includes(status) ? (status as NoteStatus) : "активна",
    updated,
    row,
  };
}

/**
 * The notes sheet. Made on first use (`create`): the folder «AI-secretary» (found or made), the sheet «Нотатки» in it,
 * and the owner is told once where it is. A sheet the owner deleted is made anew — and the owner is told again.
 * Null when there is none and `create` is false.
 */
export async function notesSheet(env: Env, create = true): Promise<{ id: string; url: string } | null> {
  if (!(await hasWorkspaceScope(env).catch(() => false))) {
    if (!create) return null;
    throw new NotesUnavailable("no drive scope");
  }
  const settings = await loadOwnerSettings(env);
  const ws = new Workspace(env);
  if (settings.nt && (await ws.alive(settings.nt))) return { id: settings.nt, url: sheetUrl(settings.nt) };
  if (!create) return null;
  const folder = (await ws.findByName(NOTES_FOLDER, "folder")) ?? (await ws.createFolder(NOTES_FOLDER));
  // The owner's settings were lost but the sheet is there: taken back as it is.
  const found = await ws.findByName(NOTES_SHEET, "sheet", folder.id);
  let id = found?.id;
  if (!id) {
    id = (await ws.createSheet(NOTES_SHEET, HEADER)).id;
    await ws.move(id, folder.id);
  }
  await saveOwnerSettings(env, { ...(await loadOwnerSettings(env)), nt: id });
  if (!found) await announceSheet(env, sheetUrl(id), !!settings.nt);
  return { id, url: sheetUrl(id) };
}

async function announceSheet(env: Env, url: string, again: boolean): Promise<void> {
  const head = again
    ? `Таблицю «${NOTES_SHEET}» на вашому Google Диску я не знайшов (мабуть, її видалили), тож створив нову — у папці «${NOTES_FOLDER}».`
    : `Я створив на вашому Google Диску папку «${NOTES_FOLDER}», а в ній таблицю «${NOTES_SHEET}».`;
  await new Telegram(env).send(
    env.OWNER_TELEGRAM_ID,
    `📒 <b>Нотатки</b>\n\n${esc(head)} Туди я записую ваші нотатки, задачі й нагадування — її можна відкрити й правити вручну. ` +
      "Не перейменовуйте й не переносьте її, щоб я її знаходив.",
    { keyboard: [[{ text: "📒 Відкрити таблицю", url }]] },
  );
}

export async function readNotes(env: Env, sheetId: string): Promise<Note[]> {
  const rows = await new Workspace(env).readRange(sheetId, "A:H");
  return rows.flatMap((r, i) => fromRow(r, i + 1) ?? []);
}

/** A note by id (the newest row wins if the owner copied one). */
export async function findNote(env: Env, id: string): Promise<{ note: Note; sheet: { id: string; url: string } } | null> {
  const sheet = await notesSheet(env, false);
  if (!sheet) return null;
  const note = (await readNotes(env, sheet.id)).filter((n) => n.id === id).at(-1);
  return note ? { note, sheet } : null;
}

const newId = (now: number) => `n${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`;

export interface NoteInput {
  text: string;
  kind?: NoteKind;
  remindAt?: Date | null;
  repeat?: Repeat;
}

/** What happened to the reminder: set, none asked, no signal calendar (an older Google connection), in the past. */
export type ReminderState = "set" | "none" | "no-calendar" | "past";

export async function addNote(env: Env, input: NoteInput, now = Date.now()): Promise<{ note: Note; url: string; reminder: ReminderState }> {
  const sheet = (await notesSheet(env))!;
  const stamp = localTime(new Date(now));
  const fields: Omit<Note, "row"> = {
    id: newId(now),
    created: stamp,
    kind: input.kind ?? (input.remindAt ? "нагадування" : "нотатка"),
    text: input.text.trim(),
    remindAt: input.remindAt ? localTime(input.remindAt) : "",
    repeat: input.remindAt ? (input.repeat ?? "") : "",
    status: "активна",
    updated: stamp,
  };
  await new Workspace(env).appendRows(sheet.id, "A:H", [toRow(fields)]);
  const note = { ...fields, row: 0 };
  return { note, url: sheet.url, reminder: await syncReminder(env, note, now) };
}

export interface NotePatch {
  text?: string;
  kind?: NoteKind;
  /** null = no reminder any more. */
  remindAt?: Date | null;
  repeat?: Repeat;
  status?: NoteStatus;
}

export async function updateNote(env: Env, id: string, patch: NotePatch, now = Date.now()): Promise<{ note: Note; url: string; reminder: ReminderState } | null> {
  const found = await findNote(env, id);
  if (!found) return null;
  const { note: old, sheet } = found;
  const note: Note = {
    ...old,
    ...(patch.text !== undefined && patch.text.trim() ? { text: patch.text.trim() } : {}),
    ...(patch.kind ? { kind: patch.kind } : {}),
    ...(patch.remindAt !== undefined ? { remindAt: patch.remindAt ? localTime(patch.remindAt) : "" } : {}),
    ...(patch.repeat !== undefined ? { repeat: patch.repeat } : {}),
    ...(patch.status ? { status: patch.status } : {}),
    updated: localTime(new Date(now)),
  };
  if (!note.remindAt) note.repeat = "";
  await new Workspace(env).updateRange(sheet.id, `A${old.row}:H${old.row}`, [toRow(note)]);
  return { note, url: sheet.url, reminder: await syncReminder(env, note, now) };
}

/** The note's signal in step with it: set while it is active with a reminder ahead (or repeating), removed otherwise. */
async function syncReminder(env: Env, note: Note, now: number): Promise<ReminderState> {
  const at = note.remindAt ? parseKyivLocal(note.remindAt) : null;
  const wanted = note.status === "активна" && at && (note.repeat || at.getTime() > now - MINUTE);
  if (!wanted) {
    await removeSignal(env, `${NOTE_PREFIX}${note.id}`);
    return at && note.status === "активна" ? "past" : "none";
  }
  const sc = await signalCalendar(env).catch(() => null);
  if (!sc) return "no-calendar";
  await putSignal(new Calendar(env, sc), `${NOTE_PREFIX}${note.id}`, note.text, at, note.repeat);
  return "set";
}

async function putSignal(cal: Calendar, key: string, text: string, at: Date, repeat: Repeat): Promise<void> {
  const end = new Date(at.getTime() + 5 * MINUTE);
  await cal.putEvent({
    id: shadowId(key),
    status: "confirmed",
    summary: `🔔 ${text.replace(/\s+/g, " ").slice(0, 80)}`,
    start: { dateTime: toKyivIso(at), timeZone: TZ },
    end: { dateTime: toKyivIso(end), timeZone: TZ },
    ...(RRULE[repeat] ? { recurrence: [RRULE[repeat]] } : {}),
    transparency: "transparent",
    visibility: "private",
    reminders: { useDefault: false, overrides: [{ method: "email", minutes: 0 }] },
    extendedProperties: { private: { aisFor: key } },
  } as GEvent & Record<string, unknown>);
}

async function removeSignal(env: Env, key: string): Promise<void> {
  const sc = (await loadOwnerSettings(env).catch(() => ({ sc: undefined }))).sc;
  if (sc) await new Calendar(env, sc).deleteSilently(shadowId(key)).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------------------------
// The reminder in Telegram.

/** What a note reference in a bot message looks like (hidden data): a reply to it goes to the notes agent. */
export interface NoteRef {
  k: "note";
  id: string;
}

const REPEAT_LABEL = (r: Repeat) => (r ? ` · 🔁 ${REPEATS[r]}` : "");

function reminderText(note: Note, footer?: string): string {
  return (
    hiddenData({ k: "note", id: note.id } satisfies NoteRef) +
    `🔔 <b>Нагадування</b>${esc(REPEAT_LABEL(note.repeat))}\n${esc(note.text)}${footer ? `\n\n${esc(footer)}` : ""}`
  );
}

const buttons = (id: string): InlineKeyboard => [
  [{ text: "✅ Зроблено", callback_data: `nt:done:${id}` }],
  [
    { text: "⏰ Через годину", callback_data: `nt:hour:${id}` },
    { text: "📅 Завтра", callback_data: `nt:tmr:${id}` },
  ],
];

/**
 * A note's signal email arrived: the reminder goes to Telegram once, whichever copy of the bot got the email
 * (claimed on the signal event — for a repeating one, on that day's occurrence).
 */
export async function sendNoteReminder(env: Env, calendarId: string, eventId: string, target: string, now = Date.now()): Promise<boolean> {
  if (!firstTime(`note:${eventId}`, DAY)) return false;
  const cal = new Calendar(env, calendarId);
  const ev = await cal.getEvent(eventId).catch(() => null);
  if (!ev || ev.status === "cancelled") return false;
  const props = ev.extendedProperties?.private ?? {};
  if (props.aisSent) return false;
  if (!(await cal.claimPrivate(ev, { ...props, aisSent: "1" }))) return false;
  const id = target.slice(NOTE_PREFIX.length).replace(SNOOZE, "");
  // A snooze signal is used once.
  if (target.endsWith(SNOOZE)) await cal.deleteSilently(shadowId(target)).catch(() => undefined);
  const found = await findNote(env, id).catch(() => null);
  if (!found || found.note.status !== "активна") {
    // The note was done, archived or removed from the sheet by hand: its signal goes too.
    if (!target.endsWith(SNOOZE)) await cal.deleteSilently(shadowId(target)).catch(() => undefined);
    return false;
  }
  await new Telegram(env).send(env.OWNER_TELEGRAM_ID, reminderText(found.note), { keyboard: buttons(id) });
  return true;
}

/**
 * ✅ / ⏰ / 📅 under a reminder, in code (no AI). Done: a one-off note is marked done; a repeating one stays for its next
 * time. Later: a one-off reminder moves; a repeating one gets a one-off extra reminder and keeps its schedule.
 * Returns the reminder's new text (the buttons go) and a short answer for the button.
 */
export async function noteButton(env: Env, action: "done" | "hour" | "tmr", id: string, now = Date.now()): Promise<{ html: string; toast: string } | null> {
  const found = await findNote(env, id);
  if (!found) return null;
  const { note } = found;
  if (action === "done") {
    if (note.repeat) return { html: reminderText(note, "✅ Зроблено. Наступне нагадування — за розкладом."), toast: "✅" };
    await updateNote(env, id, { status: "зроблено" }, now);
    return { html: reminderText(note, "✅ Зроблено"), toast: "✅ Зроблено" };
  }
  const at = new Date(Math.ceil((now + (action === "hour" ? HOUR : DAY)) / MINUTE) * MINUTE);
  if (note.repeat) {
    const sc = await signalCalendar(env).catch(() => null);
    if (sc) await putSignal(new Calendar(env, sc), `${NOTE_PREFIX}${id}${SNOOZE}`, note.text, at, "");
  } else {
    await updateNote(env, id, { remindAt: at }, now);
  }
  const when = action === "hour" ? `о ${formatTime(at)}` : `${formatDay(at, new Date(now))} о ${formatTime(at)}`;
  return { html: reminderText(note, `⏰ Нагадаю ${when}`), toast: `⏰ ${when}` };
}

// ---------------------------------------------------------------------------------------------------------------
// The morning report's block.

/** Whether a note's reminder falls on that Kyiv day (a repeating one by its rule, from its first time on). */
export function remindsOn(note: Note, day: string): boolean {
  if (!note.remindAt || note.status !== "активна") return false;
  const first = note.remindAt.slice(0, 10);
  if (day < first) return false;
  if (!note.repeat) return day === first;
  if (note.repeat === "daily") return true;
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (note.repeat === "weekdays") return weekday >= 1 && weekday <= 5;
  const [fy, fm, fd] = first.split("-").map(Number) as [number, number, number];
  if (note.repeat === "weekly") return weekday === new Date(Date.UTC(fy, fm - 1, fd)).getUTCDay();
  return d === fd;
}

/**
 * «📒 Нотатки» in the morning report: today's reminders, open tasks, and on Mondays the past week in numbers. Empty when
 * there is no notes sheet yet (it is never made just for the report).
 */
export async function notesDigest(env: Env, now = Date.now()): Promise<string[]> {
  const sheet = await notesSheet(env, false);
  if (!sheet) return [];
  const notes = await readNotes(env, sheet.id);
  const today = toKyivDate(new Date(now));
  const lines: string[] = [];
  const due = notes.filter((n) => remindsOn(n, today)).sort((a, b) => a.remindAt.slice(11).localeCompare(b.remindAt.slice(11)));
  if (due.length) lines.push("📒 <b>Нагадування на сьогодні:</b>", ...due.map((n) => `• ${n.remindAt.slice(11)} — ${esc(n.text)}${n.repeat ? " 🔁" : ""}`));
  const tasks = notes.filter((n) => n.kind === "задача" && n.status === "активна" && !due.includes(n));
  if (tasks.length) {
    lines.push(`📝 <b>Відкриті задачі (${tasks.length}):</b>`, ...tasks.slice(0, 5).map((n) => `• ${esc(n.text)}`));
    if (tasks.length > 5) lines.push(`…і ще ${tasks.length - 5} — у таблиці «${NOTES_SHEET}»`);
  }
  if (kyivParts(new Date(now)).weekday === 1) {
    const weekAgo = localTime(new Date(now - 7 * DAY));
    const added = notes.filter((n) => n.created >= weekAgo).length;
    const done = notes.filter((n) => n.status === "зроблено" && n.updated >= weekAgo).length;
    const open = notes.filter((n) => n.status === "активна" && n.kind !== "нотатка").length;
    if (added || done) lines.push(`📊 <b>За тиждень:</b> записано ${added}, зроблено ${done}, ще відкрито ${open}`);
  }
  if (lines.length) lines.push(`<a href="${sheet.url}">Відкрити нотатки</a>`);
  return lines;
}
