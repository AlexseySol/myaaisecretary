import { ConfigError, type Env, parseGoogleClient } from "../env";
import { connectLink, loadIntegrations, saveIntegrations } from "../google/oauth";
import { applyIntegrations, integrationSource } from "../integrations";
import { esc, Telegram } from "../telegram/api";
import type { TgMessage } from "../telegram/types";

/**
 * The Google OAuth client, given in the bot: the owner sends the JSON file downloaded from Google Cloud (or pastes its
 * text). It is checked, kept encrypted in the pinned message (Integrations.google) and the owner's message is deleted;
 * then «Підключити Google» works. The deployment needs only the Telegram token, the owner's ID and the OpenRouter key.
 */

const api = (id: string) => `https://console.cloud.google.com/apis/library/${id}`;

/** What to do in Google Cloud to get the file, and where to send it. */
export async function askGoogleClient(env: Env, chatId: number): Promise<void> {
  const tg = new Telegram(env);
  if (integrationSource(env, "google") === "variable") {
    await tg.send(chatId, "Google-клієнт уже заданий у налаштуваннях Vercel.", { keyboard: [[{ text: "🔗 Підключити Google", url: await connectLink(env) }]] });
    return;
  }
  await tg.send(
    chatId,
    [
      "🔑 <b>Підключення Google — крок 1 із 2: файл Google-клієнта</b>",
      "",
      `1. <a href="https://console.cloud.google.com/projectcreate">Створіть проєкт</a> у Google Cloud (будь-яка назва).`,
      `2. Увімкніть API (кожне — <b>Enable</b>): <a href="${api("calendar-json.googleapis.com")}">Calendar</a>, <a href="${api("gmail.googleapis.com")}">Gmail</a>, <a href="${api("drive.googleapis.com")}">Drive</a>, <a href="${api("sheets.googleapis.com")}">Sheets</a>, <a href="${api("docs.googleapis.com")}">Docs</a>, <a href="${api("pubsub.googleapis.com")}">Cloud Pub/Sub</a>.`,
      `3. <a href="https://console.cloud.google.com/auth/overview">Google Auth Platform</a> → Get started: назва AI-secretary, ваша пошта; Audience — Internal (акаунт компанії) або External (Gmail), для External потім <b>Publish app</b>.`,
      `4. <a href="https://console.cloud.google.com/auth/clients">Clients</a> → <b>Create client</b> → тип <b>Desktop app</b> → Create → <b>Download JSON</b>.`,
      "",
      "📎 <b>Надішліть цей файл</b> (<code>client_secret_….json</code>) сюди, у чат. Я перевірю його, збережу зашифрованим і видалю з чату.",
      "",
      "<i>Докладніше з відео — /help → 📖 Google.</i>",
    ].join("\n"),
  );
}

/** The JSON text of a message: a sent .json file or pasted text. Null when it is neither. */
async function jsonOf(env: Env, msg: TgMessage): Promise<string | null> {
  const doc = msg.document;
  if (doc && (doc.mime_type === "application/json" || /\.json$/i.test(doc.file_name ?? ""))) {
    if ((doc.file_size ?? 0) > 100_000) return null;
    const { bytes } = await new Telegram(env).download(doc.file_id);
    return new TextDecoder().decode(bytes);
  }
  const text = msg.text?.trim() ?? "";
  return text.startsWith("{") && /"(installed|web)"\s*:/.test(text) ? text : null;
}

/** A Google client file (or its text) from the owner: saved and answered. False when the message is not one. */
export async function handleGoogleClientFile(env: Env, msg: TgMessage): Promise<boolean> {
  const raw = await jsonOf(env, msg).catch(() => null);
  if (!raw || !/"client_id"|"installed"|"web"/.test(raw)) return false;
  const tg = new Telegram(env);
  // The secret has no business staying in the chat.
  await tg.call("deleteMessage", { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => undefined);
  let client;
  try {
    client = parseGoogleClient(raw);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    await tg.send(msg.chat.id, "😔 Це не файл Google-клієнта. Потрібен JSON, завантажений у Google Cloud → Clients → <b>Download JSON</b>.", {
      keyboard: [[{ text: "📖 Як його отримати", callback_data: "gclient" }]],
    });
    return true;
  }
  if (integrationSource(env, "google") === "variable") {
    await tg.send(msg.chat.id, "Google-клієнт уже заданий у налаштуваннях Vercel — файл не потрібен.");
    return true;
  }
  const current = await loadIntegrations(env);
  await saveIntegrations(env, {
    ...current,
    google: { i: client.GOOGLE_CLIENT_ID, s: client.GOOGLE_CLIENT_SECRET, ...(client.GOOGLE_PROJECT_ID ? { p: client.GOOGLE_PROJECT_ID } : {}), d: client.GOOGLE_OAUTH_MODE === "desktop" },
  });
  await applyIntegrations(env);
  const web = client.GOOGLE_OAUTH_MODE === "web";
  await tg.send(
    msg.chat.id,
    `✅ <b>Файл Google-клієнта збережено</b>${client.GOOGLE_PROJECT_ID ? ` (проєкт ${esc(client.GOOGLE_PROJECT_ID)})` : ""}.\n\n` +
      "<b>Крок 2 із 2:</b> натисніть кнопку, увійдіть у Google і на екрані з дозволами поставте <b>«Вибрати все»</b>." +
      (web ? `\n\n⚠️ Це клієнт типу «Web application»: у ньому має бути redirect URI <code>${esc(env.PUBLIC_URL)}/api/oauth/callback</code>. Простіше — створити клієнт типу <b>Desktop app</b>.` : ""),
    { keyboard: [[{ text: "🔗 Підключити Google", url: await connectLink(env) }]] },
  );
  return true;
}
