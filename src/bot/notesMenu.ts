import type { Env } from "../env";
import { loadDigestChoice } from "../google/digest";
import { type Note, NOTES_FOLDER, NOTES_SHEET, notesSheet, NotesUnavailable, readNotes, REPEATS } from "../google/notes";
import { connectLink, hasGoogleAuth, loadOwnerSettings, saveOwnerSettings } from "../google/oauth";
import { hasWorkspaceScope } from "../google/workspace";
import { parseKyivLocal, toKyivDate } from "../lib/time";
import { esc, Telegram } from "../telegram/api";
import type { InlineKeyboard } from "../telegram/types";

/**
 * /notes and /settings → «📒 Нотатки»: what is in the notes sheet, without AI — active notes, upcoming reminders, to-dos,
 * done ones; the link to the sheet; whether the notes block is in the morning report. Buttons «nm:…».
 */

export type NotesFilter = "all" | "rem" | "todo" | "done";
const FILTERS: Record<NotesFilter, string> = { all: "📋 Усе", rem: "⏰ Нагадування", todo: "📝 Справи", done: "✅ Зроблені" };
const SHOWN = 15;

const line = (n: Note, i: number) =>
  `${i + 1}. ${esc(n.text)}${n.remindAt ? ` — ⏰ ${esc(n.remindAt.slice(8, 10))}.${esc(n.remindAt.slice(5, 7))} ${esc(n.remindAt.slice(11))}` : ""}${n.repeat ? ` 🔁 ${REPEATS[n.repeat]}` : ""}`;

export async function notesView(env: Env, filter: NotesFilter = "all", back = false, now = Date.now()): Promise<{ html: string; keyboard: InlineKeyboard }> {
  const done: InlineKeyboard = back ? [[{ text: "⬅️ Готово", callback_data: "set:back" }]] : [];
  if (!(await hasGoogleAuth(env))) {
    return { html: "📒 <b>Нотатки</b>\n\nНотатки зберігаються на вашому Google Диску — спершу підключіть Google в /settings.", keyboard: done };
  }
  if (!(await hasWorkspaceScope(env).catch(() => false))) {
    return {
      html: "📒 <b>Нотатки</b>\n\nНотатки зберігаються на вашому Google Диску, а доступу до нього немає. Перепідключіть Google й поставте всі галочки.",
      keyboard: [[{ text: "🔄 Підключити Google з усіма галочками", url: await connectLink(env) }], ...done],
    };
  }
  let sheet: { id: string; url: string } | null;
  try {
    sheet = await notesSheet(env);
  } catch (err) {
    if (err instanceof NotesUnavailable) sheet = null;
    else throw err;
  }
  if (!sheet) return { html: "📒 <b>Нотатки</b>\n\nНе вдалося відкрити таблицю нотаток. Спробуйте ще раз за хвилину.", keyboard: done };
  const notes = await readNotes(env, sheet.id);
  const active = notes.filter((n) => n.status === "активна");
  const today = toKyivDate(new Date(now));
  // Upcoming first; a repeating one has no end. Passed one-off reminders are left out.
  const reminders = active
    .filter((n) => n.remindAt && (n.repeat || (parseKyivLocal(n.remindAt)?.getTime() ?? 0) > now))
    .sort((a, b) => (a.repeat ? today + a.remindAt.slice(10) : a.remindAt).localeCompare(b.repeat ? today + b.remindAt.slice(10) : b.remindAt));
  const todo = active.filter((n) => n.kind === "задача");
  const list: Record<NotesFilter, Note[]> = {
    all: [...active].reverse(),
    rem: reminders,
    todo: [...todo].reverse(),
    done: notes.filter((n) => n.status === "зроблено").reverse(),
  };
  const shown = list[filter];
  const empty: Record<NotesFilter, string> = {
    all: "Поки порожньо. Напишіть мені «запиши ідею: …» або «нагадай мені завтра о 9 …».",
    rem: "Нагадувань попереду немає.",
    todo: "Відкритих справ немає.",
    done: "Зроблених ще немає.",
  };
  const inDigest = (await loadDigestChoice(env)).blocks.includes("notes");
  const html = [
    "📒 <b>Нотатки</b>",
    `Таблиця «${NOTES_SHEET}» у папці «${NOTES_FOLDER}» на вашому Google Диску — можна відкрити й правити вручну.`,
    "",
    `Активних: <b>${active.length}</b> · нагадувань попереду: <b>${reminders.length}</b> · справ: <b>${todo.length}</b>`,
    "",
    `<b>${FILTERS[filter]}</b>`,
    ...(shown.length ? shown.slice(0, SHOWN).map(line) : [empty[filter]]),
    ...(shown.length > SHOWN ? [`…і ще ${shown.length - SHOWN} — у таблиці`] : []),
    "",
    "<i>Змінити, позначити зробленим чи прибрати — напишіть мені, напр. «познач зробленим 2» або «перенеси нагадування про банк на 18:00».</i>",
  ].join("\n");
  const keyboard: InlineKeyboard = [
    (Object.keys(FILTERS) as NotesFilter[]).slice(0, 2).map((f) => ({ text: `${f === filter ? "• " : ""}${FILTERS[f]}`, callback_data: `nm:${f}${back ? ":s" : ""}` })),
    (Object.keys(FILTERS) as NotesFilter[]).slice(2).map((f) => ({ text: `${f === filter ? "• " : ""}${FILTERS[f]}`, callback_data: `nm:${f}${back ? ":s" : ""}` })),
    [{ text: "📒 Відкрити таблицю", url: sheet.url }],
    [{ text: `☀️ У ранковому звіті: ${inDigest ? "✅" : "❌"}`, callback_data: `nm:dg:${filter}${back ? ":s" : ""}` }],
    ...done,
  ];
  return { html, keyboard };
}

/** /notes: the menu as a new message. */
export async function showNotes(env: Env, chatId: number): Promise<void> {
  const tg = new Telegram(env);
  await tg.typing(chatId);
  const view = await notesView(env);
  await tg.send(chatId, view.html, { keyboard: view.keyboard });
}

/** A «nm:…» button: another list, or the morning report's notes block on / off; the menu is redrawn in place. */
export async function handleNotesButton(env: Env, data: string, callbackId: string, chatId: number, messageId: number): Promise<void> {
  const tg = new Telegram(env);
  const m = /^nm:(?:(dg):)?(all|rem|todo|done)(:s)?$/.exec(data);
  if (!m) return void (await tg.answerCallback(callbackId).catch(() => undefined));
  let toast: string | undefined;
  if (m[1]) {
    const settings = await loadOwnerSettings(env);
    const blocks = (await loadDigestChoice(env)).blocks;
    const on = !blocks.includes("notes");
    settings.dg = { ...settings.dg, b: on ? [...blocks, "notes"] : blocks.filter((b) => b !== "notes") };
    await saveOwnerSettings(env, settings);
    toast = on ? "Нотатки будуть у ранковому звіті" : "Нотатки прибрано з ранкового звіту";
  }
  await tg.answerCallback(callbackId, toast).catch(() => undefined);
  const view = await notesView(env, m[2] as NotesFilter, !!m[3]);
  await tg.edit(chatId, messageId, view.html, view.keyboard);
}

/**
 * Right after an update (and daily, and when Google is connected): the notes sheet is made at once — the owner is told
 * where it is — instead of waiting for the first note. Only with the Drive permission; quiet otherwise.
 */
export async function ensureNotesSheet(env: Env): Promise<void> {
  if (!(await hasGoogleAuth(env)) || !(await hasWorkspaceScope(env).catch(() => false))) return;
  await notesSheet(env);
}
