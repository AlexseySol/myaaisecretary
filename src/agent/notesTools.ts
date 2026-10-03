import type { Env } from "../env";
import {
  addNote,
  findNote,
  KINDS,
  type Note,
  type NoteKind,
  type NotePatch,
  notesSheet,
  NotesUnavailable,
  parseWhen,
  readNotes,
  type ReminderState,
  type Repeat,
  REPEATS,
  updateNote,
} from "../google/notes";
import { wakeReady } from "../google/pubsub";
import { hasWorkspaceScope } from "../google/workspace";
import { str, type Tool } from "./runner";

/**
 * The Notes Agent's tools: the owner's notes, tasks and personal reminders in the sheet «Нотатки» (google/notes.ts).
 * Add, find, change, mark done, archive — nothing is ever deleted.
 */

const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required });
const s = (description: string) => ({ type: "string", description });
const KIND = { type: "string", enum: [...KINDS], description: "нотатка — думка чи інформація; задача — що зробити; нагадування — нагадати в певний час" };
const REPEAT = { type: "string", enum: Object.keys(REPEATS).filter(Boolean).concat("none"), description: "Repeat the reminder: daily, weekdays, weekly, monthly, none" };
const WHEN = s("When to remind: ISO 8601 with offset, e.g. 2026-10-04T09:00:00+03:00 (Kyiv time); empty — no reminder");

function brief(n: Note): Record<string, unknown> {
  return {
    id: n.id,
    kind: n.kind,
    text: n.text,
    ...(n.remindAt ? { remindAt: n.remindAt } : {}),
    ...(n.repeat ? { repeat: REPEATS[n.repeat] } : {}),
    status: n.status,
    created: n.created,
  };
}

const repeatArg = (v: string): Repeat | undefined => (v === "none" ? "" : v in REPEATS ? (v as Repeat) : undefined);

async function reminderNote(env: Env, state: ReminderState): Promise<string | undefined> {
  if (state === "past") return "Цей час уже минув — нагадування не поставлено. Спитай власника про інший час.";
  if (state === "no-calendar") return "Нагадування збережено в таблиці, але надіслати його я не зможу: перепідключіть Google з усіма галочками (/settings).";
  if (state === "set" && !(await wakeReady(env))) {
    return "Нагадування поставлено, але Google ще не будить бота: щоб воно прийшло вчасно, натисніть /settings → ⏰ → «🔁 Налаштувати». Інакше побачите його в ранковому звіті.";
  }
  return undefined;
}

/** A tool's answer when notes cannot work (no Drive permission): the agent tells the owner how to fix it. */
const unavailable = { error: "Немає доступу до Google Диска — нотатки зберігаються там. Перепідключіть Google з усіма галочками в /settings." };

function guarded(run: Tool["run"]): Tool["run"] {
  return async (a) => {
    try {
      return await run(a);
    } catch (err) {
      if (err instanceof NotesUnavailable) return unavailable;
      throw err;
    }
  };
}

export function notesTools(env: Env): Tool[] {
  return [
    {
      spec: {
        name: "note_add",
        description:
          "Write down a note, a task or a personal reminder in the owner's notes (Google Sheet «Нотатки»). With remindAt the owner gets a Telegram reminder at that time (repeat for a recurring one).",
        parameters: object({ text: s("The note itself, in the owner's words, short and clear"), kind: KIND, remindAt: WHEN, repeat: REPEAT }, ["text"]),
      },
      run: guarded(async (a) => {
        const text = str(a, "text");
        if (!text) return { error: "Порожня нотатка" };
        const when = str(a, "remindAt");
        const remindAt = when ? parseWhen(when) : null;
        if (when && !remindAt) return { error: "Не зрозумів час нагадування: потрібен формат 2026-10-04T09:00:00+03:00" };
        const { note, url, reminder } = await addNote(env, { text, kind: (str(a, "kind") as NoteKind) || undefined, remindAt, repeat: repeatArg(str(a, "repeat")) });
        return { saved: brief(note), sheet: url, ...(reminder === "set" ? { reminder: "set" } : {}), note: await reminderNote(env, reminder) };
      }),
    },
    {
      spec: {
        name: "note_search",
        description:
          "Find the owner's notes by words (empty query — the latest). status: active (default), done, archived or all. Also for «що я записував…», «які в мене нагадування / задачі».",
        parameters: object(
          {
            query: s("Words to find; empty for all"),
            kind: { ...KIND, enum: [...KINDS, "any"] },
            status: { type: "string", enum: ["active", "done", "archived", "all"] },
            limit: { type: "number", description: "How many, default 20" },
          },
          [],
        ),
      },
      run: guarded(async (a) => {
        const sheet = await notesSheet(env, false);
        if (!sheet) return (await hasWorkspaceScope(env).catch(() => false)) ? { notes: [], note: "Нотаток ще немає" } : unavailable;
        const words = str(a, "query").toLowerCase().split(/\s+/).filter(Boolean);
        const status = str(a, "status") || "active";
        const kind = str(a, "kind");
        const wanted = { active: "активна", done: "зроблено", archived: "архів" }[status];
        const all = (await readNotes(env, sheet.id)).filter(
          (n) =>
            (status === "all" || n.status === wanted) &&
            (!kind || kind === "any" || n.kind === kind) &&
            words.every((w) => n.text.toLowerCase().includes(w)),
        );
        const limit = Math.min(Number(a.limit) || 20, 50);
        const shown = all.slice(-limit).reverse();
        return { notes: shown.map(brief), total: all.length, sheet: sheet.url, ...(all.length > limit ? { more: all.length - limit } : {}) };
      }),
    },
    {
      spec: {
        name: "note_update",
        description:
          "Change a note by id (from note_search): its text, kind, reminder time (remindAt empty string — remove the reminder), repeat, or status done / active again.",
        parameters: object(
          { id: s("Note id"), text: s("New text"), kind: KIND, remindAt: s("New reminder time (ISO with offset), or «none» to remove it"), repeat: REPEAT, status: { type: "string", enum: ["done", "active"] } },
          ["id"],
        ),
      },
      run: guarded(async (a) => {
        const patch: NotePatch = {};
        if (str(a, "text")) patch.text = str(a, "text");
        if (str(a, "kind")) patch.kind = str(a, "kind") as NoteKind;
        if ("remindAt" in a) {
          const when = str(a, "remindAt");
          if (!when || when === "none") patch.remindAt = null;
          else {
            const at = parseWhen(when);
            if (!at) return { error: "Не зрозумів час нагадування: потрібен формат 2026-10-04T09:00:00+03:00" };
            patch.remindAt = at;
          }
        }
        const repeat = repeatArg(str(a, "repeat"));
        if (repeat !== undefined) patch.repeat = repeat;
        if (str(a, "status")) patch.status = str(a, "status") === "done" ? "зроблено" : "активна";
        const done = await updateNote(env, str(a, "id"), patch);
        if (!done) return { error: "Нотатку з таким id не знайдено — знайди її через note_search" };
        return { updated: brief(done.note), sheet: done.url, note: await reminderNote(env, done.reminder) };
      }),
    },
    {
      spec: {
        name: "note_archive",
        description: "Archive a note by id: it leaves the lists and its reminder stops, but stays in the sheet. Notes are never deleted.",
        parameters: object({ id: s("Note id") }, ["id"]),
      },
      run: guarded(async (a) => {
        if (!(await findNote(env, str(a, "id")))) return { error: "Нотатку з таким id не знайдено — знайди її через note_search" };
        const done = await updateNote(env, str(a, "id"), { status: "архів" });
        return { archived: brief(done!.note), sheet: done!.url };
      }),
    },
  ];
}
