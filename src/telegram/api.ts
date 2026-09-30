import type { Config } from "../env";
import { expectOk, fetchWithRetry, HttpError } from "../lib/http";
import type { InlineKeyboard, TgFile, TgMessage } from "./types";

/** Telegram Bot API allows bots to download files up to 20 MB. */
export const TG_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

export interface SendOptions {
  keyboard?: InlineKeyboard;
  replyTo?: number;
  /** Show a one-time reply keyboard (e.g. "share contact"). */
  replyKeyboard?: { text: string; request_contact?: boolean }[][];
  removeKeyboard?: boolean;
  /** The persistent menu under the input field (reply keyboard); its buttons send their text. */
  menu?: string[][];
  /** Opens the reply field on the owner's side, so the answer comes back as a reply to this message. */
  forceReply?: string;
}

export class Telegram {
  constructor(private readonly env: Pick<Config, "TELEGRAM_BOT_TOKEN">) {}

  async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetchWithRetry(`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { ok: boolean; result: T; description?: string } | null;
    if (!json?.ok) throw new HttpError(`telegram.${method}`, res.status, json?.description ?? "");
    return json.result;
  }

  private markup(opts: SendOptions): Record<string, unknown> | undefined {
    if (opts.forceReply !== undefined) return { force_reply: true, input_field_placeholder: opts.forceReply || undefined };
    if (opts.keyboard) return { inline_keyboard: opts.keyboard };
    if (opts.menu) return { keyboard: opts.menu.map((row) => row.map((text) => ({ text }))), resize_keyboard: true, is_persistent: true };
    if (opts.replyKeyboard) return { keyboard: opts.replyKeyboard, resize_keyboard: true, one_time_keyboard: true };
    if (opts.removeKeyboard) return { remove_keyboard: true };
    return undefined;
  }

  /**
   * Sends an HTML-formatted message. Callers must escape user content with `esc`. A text longer than Telegram takes
   * (4096 characters) goes as several messages split between lines; the buttons come with the last one.
   */
  async send(chatId: number, html: string, opts: SendOptions = {}): Promise<TgMessage> {
    const parts = splitMessage(html);
    let last: TgMessage | undefined;
    for (const [i, part] of parts.entries()) {
      const final = i === parts.length - 1;
      const one = (text: string, parseMode?: "HTML") =>
        this.call<TgMessage>("sendMessage", {
          chat_id: chatId,
          text,
          parse_mode: parseMode,
          link_preview_options: { is_disabled: true },
          reply_markup: final ? this.markup(opts) : undefined,
          reply_parameters: i === 0 && opts.replyTo ? { message_id: opts.replyTo, allow_sending_without_reply: true } : undefined,
        });
      if (parts.length === 1) return one(part, "HTML");
      // A cut may split a tag that spans lines: that piece then goes as plain text.
      last = await one(part, "HTML").catch((err) => {
        if (!(err instanceof HttpError && err.status === 400)) throw err;
        return one(stripHtml(part));
      });
    }
    return last!;
  }

  async edit(chatId: number, messageId: number, html: string, keyboard?: InlineKeyboard): Promise<void> {
    try {
      await this.call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: html,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
      });
    } catch (err) {
      // Re-rendering an unchanged card is not an error.
      if (err instanceof HttpError && err.body.includes("message is not modified")) return;
      throw err;
    }
  }

  async answerCallback(id: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: id, text });
  }

  /**
   * Shows "печатает…" until the returned function is called. Telegram hides the status after about 5 seconds, so it
   * is repeated every 4 — the owner sees the bot working for the whole time an LLM call or a transcription takes.
   */
  keepTyping(chatId: number): () => void {
    void this.typing(chatId);
    const timer = setInterval(() => void this.typing(chatId), 4000);
    return () => clearInterval(timer);
  }

  async typing(chatId: number): Promise<void> {
    await this.call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => undefined);
  }

  /** Sends a file (e.g. an Excel report) with an HTML caption. */
  async sendDocument(chatId: number, filename: string, bytes: Uint8Array, caption = "", mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"): Promise<void> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) {
      form.append("caption", caption);
      form.append("parse_mode", "HTML");
    }
    form.append("document", new Blob([new Uint8Array(bytes)], { type: mime }), filename);
    const res = await fetchWithRetry(`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: "POST", body: form });
    const json = (await res.json().catch(() => null)) as { ok: boolean; description?: string } | null;
    if (!json?.ok) throw new HttpError("telegram.sendDocument", res.status, json?.description ?? "");
  }

  /** Downloads a file (≤ 20 MB). */
  async download(fileId: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; path: string }> {
    const file = await this.call<TgFile>("getFile", { file_id: fileId });
    if (!file.file_path) throw new Error("Telegram returned no file_path");
    const res = await expectOk(
      "telegram.file",
      await fetchWithRetry(`https://api.telegram.org/file/bot${this.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`, {}),
    );
    return { bytes: new Uint8Array(await res.arrayBuffer()), path: file.file_path };
  }
}

/** Telegram takes up to 4096 characters of text; tags do not count, so this leaves room. */
export const MESSAGE_LIMIT = 4000;

/** Pieces of at most MESSAGE_LIMIT, cut at a blank line, else at a line end, else anywhere. */
export function splitMessage(html: string, limit = MESSAGE_LIMIT): string[] {
  const parts: string[] = [];
  let rest = html;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf("\n\n");
    if (cut < limit / 2) cut = window.lastIndexOf("\n");
    if (cut < limit / 2) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  parts.push(rest);
  return parts;
}

const stripHtml = (html: string) =>
  html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/** Escapes text for Telegram HTML parse mode. */
export function esc(text: string | null | undefined): string {
  return (text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
