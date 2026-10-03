import { forgetConversation } from "../agent/memory";
import { helpText, sendConnectGoogle, startOnboarding, tourText } from "../bot/onboarding";
import { sendTab } from "../bot/tabs";
import { handleConnectAnswer } from "../bot/connect";
import { handleSettingsButton, showSettings } from "../bot/settings";
import { applyIntegrations } from "../integrations";
import { type BitrixAction, showBitrixMenu, showReportMenu } from "../bitrix/menu";
import { askGoogleClient, handleGoogleClientFile } from "../bot/googleClient";
import { GUIDE_MENU, type Guide, handleGuideReply, showGuide, showGuideMenu } from "../bot/guides";
import { loadOwner, type User } from "../bot/owner";
import { googleConfigured, isOwner, type Env } from "../env";
import { connectWithCode } from "../google/connect";
import { connectLink, hasGoogleAuth, parseGoogleAnswer, verifyState } from "../google/oauth";
import { formatTime, toKyivDate } from "../lib/time";
import type { MailRef } from "../google/gmailPush";
import type { EventRef } from "../google/sync";
import { noteButton, type NoteRef } from "../google/notes";
import { handleNotesButton, showNotes } from "../bot/notesMenu";
import { appendBatch } from "../session";
import { Telegram, TG_DOWNLOAD_LIMIT } from "./api";
import { readHidden } from "./hidden";
import type { TgCallbackQuery, TgMessage, TgMessageOrigin, TgUpdate, TgUser } from "./types";

/** A burst of forwarded messages is handled as one conversation after this quiet period. */
export const FORWARD_DEBOUNCE_S = 8;

/**
 * The n8n "Telegram Trigger → Switch — Input Type → Normalize Input" part. The bot serves exactly one person:
 * OWNER_TELEGRAM_ID; messages and button presses from anyone else are ignored without a reply.
 */
async function authorize(env: Env, from: TgUser): Promise<User | null> {
  if (from.is_bot || !isOwner(env, from.id)) return null;
  return loadOwner(env, from);
}

export async function handleUpdate(env: Env, update: TgUpdate): Promise<void> {
  if (update.callback_query) return handleCallback(env, update.callback_query);
  const msg = update.message;
  if (!msg?.from || msg.chat.type !== "private") return;

  const user = await authorize(env, msg.from);
  if (!user) {
    console.warn(`Ignored message from non-owner ${msg.from.id}`);
    return;
  }

  // Bitrix24 / Zoom keys given in /settings become env values for this update.
  await applyIntegrations(env);
  const text = msg.text?.trim() ?? "";
  if (text.startsWith("/") && (await handleCommand(env, user, text))) return;
  await handleOwnerMessage(env, user, msg);
}

function originName(origin: TgMessageOrigin, owner: User): string {
  switch (origin.type) {
    case "user": {
      if (origin.sender_user.id === owner.tg_id) return `${owner.full_name ?? "Я"} (власник)`;
      return [origin.sender_user.first_name, origin.sender_user.last_name].filter(Boolean).join(" ");
    }
    case "hidden_user":
      return origin.sender_user_name;
    case "chat":
      return origin.sender_chat.title ?? "чат";
    case "channel":
      return origin.chat.title ?? "канал";
  }
}

/** "[28.09.2026 14:02] Іван Петренко: текст" — one line of a forwarded conversation. */
export function forwardedLine(msg: TgMessage, owner: User): string {
  const origin = msg.forward_origin!;
  const at = new Date(origin.date * 1000);
  const [y, m, d] = toKyivDate(at).split("-");
  const body = (msg.text ?? msg.caption ?? "").replace(/\n/g, " ").trim();
  return `[${d}.${m}.${y} ${formatTime(at)}] ${originName(origin, owner)}: ${body || "(вкладення)"}`;
}

const replyTextOf = (msg: TgMessage): string | null => msg.reply_to_message?.text ?? msg.reply_to_message?.caption ?? null;

/** The event or email a bot message is about (hidden in it), so the agent does not have to guess by its title. */
export function refOf(msg: TgMessage | undefined | null): string | null {
  const ref = readHidden<EventRef | MailRef | NoteRef>(msg);
  if (ref?.k === "ev") return `eventId: ${ref.id}`;
  if (ref?.k === "mail") return `messageId: ${ref.id}`;
  if (ref?.k === "note") return `noteId: ${ref.id}`;
  return null;
}

async function handleOwnerMessage(env: Env, user: User, msg: TgMessage): Promise<void> {
  const tg = new Telegram(env);
  const chatId = msg.chat.id;
  const image = msg.photo?.at(-1) ?? (msg.document?.mime_type?.startsWith("image/") ? msg.document : undefined);
  // A video (or a link) sent in reply to a guide becomes that guide's video.
  if (await handleGuideReply(env, msg)) return;
  // The Google client file (or its text): kept for connecting Google.
  if (await handleGoogleClientFile(env, msg)) return;

  if (msg.forward_origin) {
    await tg.typing(chatId);
    const batch = appendBatch(chatId, forwardedLine(msg, user), "forward");
    if (image) batch.lines.push(`[[photo:${image.file_id}]]`);
    await env.jobs.send({ type: "batch", chatId, seq: batch.seq }, { delaySeconds: FORWARD_DEBOUNCE_S });
    return;
  }

  if (msg.voice) {
    if ((msg.voice.file_size ?? 0) > TG_DOWNLOAD_LIMIT) {
      await tg.send(chatId, "Голосове завелике (понад 20 МБ).");
      return;
    }
    await env.jobs.send({ type: "voice", chatId, fileId: msg.voice.file_id, messageId: msg.message_id, replyText: replyTextOf(msg), replyRef: refOf(msg.reply_to_message) });
    return;
  }

  if (image || msg.document) {
    if ((image?.file_size ?? msg.document?.file_size ?? 0) > TG_DOWNLOAD_LIMIT) {
      await tg.send(chatId, "Файл завеликий (понад 20 МБ).");
      return;
    }
    // n8n: a photo goes in as its caption or "[фото]", a document as "[документ: name]"; images are shown to the model.
    const text = msg.caption || (msg.photo ? "[фото]" : `[документ: ${msg.document?.file_name ?? ""}]`);
    await env.jobs.send({
      type: "agent",
      input: { chatId, inputType: msg.photo ? "photo" : "document", text, replyText: replyTextOf(msg), replyRef: refOf(msg.reply_to_message) },
      photoIds: image ? [image.file_id] : [],
      files: !image && msg.document ? [{ id: msg.document.file_id, name: msg.document.file_name ?? "файл", mime: msg.document.mime_type ?? "" }] : [],
    });
    return;
  }

  const text = msg.text?.trim();
  if (!text) return;
  if (await handleGoogleAnswer(env, msg, text)) return;
  if (await handleConnectAnswer(env, msg, text)) return;
  await env.jobs.send({ type: "agent", input: { chatId, inputType: "text", text, replyText: replyTextOf(msg), replyRef: refOf(msg.reply_to_message) }, photoIds: [] });
}

/** Service commands; everything else, including an unknown "/…", goes to the agents. Returns true when handled. */
async function handleCommand(env: Env, user: User, text: string): Promise<boolean> {
  const tg = new Telegram(env);
  const cmd = text.split(/\s+/)[0]!.split("@")[0]!.toLowerCase();
  switch (cmd) {
    case "/start":
      // «Підключити Google» before the Google client file is there: t.me/<bot>?start=google.
      if (/^\/start\s+google$/i.test(text.trim()) && !googleConfigured(env)) {
        await askGoogleClient(env, user.tg_id);
        return true;
      }
      await startOnboarding(env, user);
      return true;
    case "/settings":
      await showSettings(env, user);
      return true;
    case "/help":
      await tg.send(user.tg_id, `${helpText()}\n\n📖 Покрокові інструкції — кнопками нижче.`, { keyboard: GUIDE_MENU });
      return true;
    case "/reset":
      await forgetConversation(env);
      await tg.send(user.tg_id, "🧹 Контекст розмови очищено.");
      return true;
    case "/notes":
      await showNotes(env, user.tg_id);
      return true;
    case "/bitrix":
    case "/tasks":
      await showBitrixMenu(env, user.tg_id);
      return true;
    case "/connect":
      if (await hasGoogleAuth(env)) await tg.send(user.tg_id, "Google уже підключено. Перепідключити — /settings.");
      else await sendConnectGoogle(env);
      return true;
  }
  return false;
}

/**
 * Buttons. Settings buttons ("set:…") are handled here at once; ✅ Прийняти / ❌ Відхилити go to the agent job,
 * which answers them in code; any other button is one more input for the Supervisor, as in n8n.
 */
async function handleCallback(env: Env, cq: TgCallbackQuery): Promise<void> {
  const user = await authorize(env, cq.from);
  if (!user) return;
  await applyIntegrations(env);
  const chatId = cq.message?.chat.id ?? user.tg_id;
  if (cq.data === "bx:report") {
    await new Telegram(env).answerCallback(cq.id).catch(() => undefined);
    await showReportMenu(env, chatId);
    return;
  }
  const bx = /^bx:(my|overdue|stats|report:(?:all|open|overdue|week|mine|given|closed))$/.exec(cq.data ?? "");
  if (bx) {
    await new Telegram(env).answerCallback(cq.id, bx[1]!.startsWith("report:") ? "Готую звіт…" : undefined).catch(() => undefined);
    await env.jobs.send({ type: "bitrix", chatId, action: bx[1] as BitrixAction });
    return;
  }
  if (cq.data?.startsWith("nm:") && cq.message) {
    await handleNotesButton(env, cq.data, cq.id, chatId, cq.message.message_id);
    return;
  }
  // ✅ / ⏰ / 📅 under a note reminder: in code, no AI.
  const nt = /^nt:(done|hour|tmr):(.+)$/.exec(cq.data ?? "");
  if (nt) {
    const tg = new Telegram(env);
    const done = await noteButton(env, nt[1] as "done" | "hour" | "tmr", nt[2]!).catch((err) => {
      console.warn("note button:", err instanceof Error ? err.message : err);
      return null;
    });
    await tg.answerCallback(cq.id, done?.toast ?? "Нотатку не знайдено в таблиці").catch(() => undefined);
    if (done && cq.message) await tg.edit(chatId, cq.message.message_id, done.html).catch(() => undefined);
    return;
  }
  if (cq.data === "gclient") {
    await new Telegram(env).answerCallback(cq.id).catch(() => undefined);
    await askGoogleClient(env, chatId);
    return;
  }
  // «⚙️ Налаштувати» under the tour, «💡 Що я вмію» in the settings.
  if (cq.data === "set:open" || cq.data === "tour") {
    await new Telegram(env).answerCallback(cq.id).catch(() => undefined);
    if (cq.data === "set:open") await showSettings(env, user);
    else await new Telegram(env).send(chatId, tourText(user.full_name), { keyboard: [[{ text: "⚙️ Налаштувати", callback_data: "set:open" }]] });
    return;
  }
  const guide = /^guide:(menu|google|telegram|bitrix)$/.exec(cq.data ?? "");
  if (guide) {
    await new Telegram(env).answerCallback(cq.id).catch(() => undefined);
    if (guide[1] === "menu") await showGuideMenu(env, chatId);
    // Google and Bitrix24: their settings tab (the step the owner is on); Telegram: the guide.
    else if (guide[1] === "google" || guide[1] === "bitrix") await sendTab(env, chatId, guide[1]);
    else await showGuide(env, chatId, guide[1] as Guide);
    return;
  }
  if (cq.data?.startsWith("set:") && cq.message) {
    await handleSettingsButton(env, user, cq.data, cq.id, cq.message.message_id);
    return;
  }
  await env.jobs.send({
    type: "agent",
    input: {
      chatId,
      inputType: "callback",
      text: `[Кнопка: ${cq.data ?? ""}]`,
      replyText: cq.message?.text ?? cq.message?.caption ?? null,
      replyRef: refOf(cq.message),
      callbackData: cq.data ?? null,
      callbackId: cq.id,
      callbackMessageId: cq.message?.message_id ?? null,
      callbackKeyboard: cq.message?.reply_markup?.inline_keyboard ?? null,
    },
    photoIds: [],
  });
}

/**
 * Desktop app Google client: after consent the owner pastes the browser's address (http://127.0.0.1/?code=…) or
 * the bare code. Returns false when the text is something else.
 */
async function handleGoogleAnswer(env: Env, msg: TgMessage, text: string): Promise<boolean> {
  const answer = parseGoogleAnswer(text);
  if (!answer) return false;
  const tg = new Telegram(env);
  const retry = { keyboard: [[{ text: "🔗 Підключити Google", url: await connectLink(env) }]] };
  // The code is single-use, but it has no business staying in the chat.
  await tg.call("deleteMessage", { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => undefined);
  if (answer.error || !answer.code) {
    await tg.send(msg.chat.id, "Підключення Google скасовано. Спробувати ще раз:", retry);
    return true;
  }
  if (answer.state && !(await verifyState(env, answer.state))) {
    await tg.send(msg.chat.id, "Це посилання вже застаріло. Натисніть кнопку й підключіть Google ще раз:", retry);
    return true;
  }
  await tg.typing(msg.chat.id);
  try {
    await connectWithCode(env, answer.code);
  } catch {
    await tg.send(msg.chat.id, "😔 Google не прийняв цей код (він діє кілька хвилин і лише один раз). Спробуйте ще раз:", retry);
  }
  return true;
}
