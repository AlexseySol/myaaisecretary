import type { Env } from "../env";
import { esc, Telegram } from "../telegram/api";

/**
 * A live mini-log of a long request: one message in the chat, edited as the agents work — each step in plain words,
 * the done ones ✅, the current one ⏳. It appears only once a tool is called (a quick answer stays clean), follows a
 * request into its continuation (the same message), and is removed when the answer comes.
 */
const LABELS: [RegExp, string][] = [
  [/^calendar_agent$/, "📅 Передаю календарю"],
  [/^gmail_agent$/, "📧 Передаю пошті"],
  [/^docs_agent$/, "📁 Передаю документам"],
  [/^notes_agent$/, "📒 Передаю нотаткам"],
  [/^bitrix_agent$/, "📋 Передаю Bitrix24"],
  [/^get_calendar_events$|^get_event$/, "📅 Дивлюся календар"],
  [/^check_free_busy$/, "🕐 Перевіряю, хто вільний"],
  [/^create_zoom_meeting$/, "🎥 Створюю Zoom"],
  [/^create_event/, "📌 Ставлю зустріч"],
  [/^rsvp_event$/, "✅ Підтверджую участь"],
  [/^reschedule_event$/, "🔁 Переношу зустріч"],
  [/^update_event_fields$/, "📝 Оновлюю зустріч"],
  [/^manage_event_attendees$/, "👥 Змінюю учасників"],
  [/^delete_event$/, "🗑 Скасовую зустріч"],
  [/^meeting_attendees$/, "👥 Шукаю учасників зустрічі"],
  [/^msg_get_many$|^thread_get_many$/, "📧 Шукаю листи"],
  [/^msg_get$|^thread_get$/, "📨 Читаю лист"],
  [/^attachment_read$/, "📎 Читаю вкладення"],
  [/^draft_/, "✍️ Готую чернетку"],
  [/^msg_send$|^msg_reply$|^draft_send$/, "📤 Надсилаю лист"],
  [/^msg_(delete|trash)|^thread_(delete|trash)/, "🗑 Прибираю лист"],
  [/^label_|^msg_(add|remove)_label/, "🏷 Мітки"],
  [/^drive_search$/, "📁 Шукаю на Диску"],
  [/^drive_read$|^sheets_read$/, "📄 Читаю файл"],
  [/^(docs|sheets)_(create|append|update)|^drive_(create|move|share)/, "💾 Записую на Диск"],
  [/^note_add$/, "📒 Записую нотатку"],
  [/^note_search$/, "📒 Шукаю в нотатках"],
  [/^note_(update|archive)$/, "📒 Оновлюю нотатку"],
  [/^(list_tasks|get_task|task_)/, "📋 Дивлюся задачі"],
  [/^(create_task|add_comment)/, "📋 Пишу в Bitrix24"],
  [/^(remember|forget)_fact$/, "🧠 Запамʼятовую"],
  [/^find_person$|^find_user$/, "🔎 Шукаю людину"],
  [/^find_/, "🔎 Шукаю"],
];

export function stepLabel(tool: string): string {
  return LABELS.find(([re]) => re.test(tool))?.[1] ?? "⚙️ Працюю";
}

/** Telegram allows about one edit a second per message. */
const EDIT_EVERY_MS = 1100;

export class Progress {
  private readonly lines: string[] = [];
  private chain: Promise<void> = Promise.resolve();
  private lastEdit = 0;
  private dirty = false;

  constructor(
    private readonly env: Env,
    private readonly chatId: number,
    /** The message of an earlier invocation of the same request (a continuation keeps it). */
    public messageId: number | null = null,
    done: string[] = [],
  ) {
    this.lines = done.map((l) => l.replace(/^⏳/, "✅"));
  }

  /** The labels so far, for a continuation. */
  get done(): string[] {
    return [...this.lines];
  }

  /** A tool is about to run. */
  step(tool: string): void {
    const label = stepLabel(tool);
    const last = this.lines.at(-1);
    if (last === `⏳ ${label}`) return;
    if (last?.startsWith("⏳ ")) this.lines[this.lines.length - 1] = `✅ ${last.slice(2)}`;
    this.lines.push(`⏳ ${label}`);
    this.dirty = true;
    this.chain = this.chain.then(() => this.flush()).catch(() => undefined);
  }

  /** The request goes on in a fresh invocation: everything up to now is done. */
  async pause(): Promise<void> {
    await this.chain;
  }

  /** The answer is here: the log goes. */
  async finish(): Promise<void> {
    await this.chain;
    if (this.messageId) await new Telegram(this.env).call("deleteMessage", { chat_id: this.chatId, message_id: this.messageId }).catch(() => undefined);
    this.messageId = null;
  }

  private render(): string {
    const shown = this.lines.slice(-12);
    return `⏳ <b>Працюю над запитом…</b>\n\n${shown.map((l) => esc(l)).join("\n")}`;
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    const wait = this.lastEdit + EDIT_EVERY_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (!this.dirty) return;
    this.dirty = false;
    this.lastEdit = Date.now();
    const tg = new Telegram(this.env);
    if (this.messageId) await tg.edit(this.chatId, this.messageId, this.render()).catch(() => undefined);
    else this.messageId = (await tg.send(this.chatId, this.render()).catch(() => null))?.message_id ?? null;
  }
}
