import { bitrixConfigured, type Env, googleConfigured, zoomConfigured } from "../env";
import { connectLink, loadGrant, missingScopes } from "../google/oauth";
import { integrationSource } from "../integrations";
import { esc, Telegram } from "../telegram/api";
import type { InlineKeyboard } from "../telegram/types";
import { guideRef, guideVideo, sendVideoFile, videoLine } from "./guides";

/**
 * /settings → a connection's tab (🔗 Google, 📋 Bitrix24, 🎥 Zoom): where the owner is and the next step, with the video
 * and the one button that step needs. Google has two steps: the client file from Google Cloud, then signing in.
 */

export type Tab = "google" | "bitrix" | "zoom";
export interface View {
  html: string;
  keyboard: InlineKeyboard;
}

const back = [{ text: "⬅️ Назад", callback_data: "set:back" }];
const api = (id: string) => `https://console.cloud.google.com/apis/library/${id}`;
const a = (href: string, text: string) => `<a href="${esc(href)}">${esc(text)}</a>`;

async function googleTab(env: Env): Promise<View> {
  const grant = await loadGrant(env).catch(() => null);
  const video = videoLine("google", await guideVideo(env, "google"));
  if (grant) {
    const missing = missingScopes(grant.scope);
    return {
      html: [
        "🔗 <b>Google</b>",
        "",
        `✅ Підключено${grant.email ? `: <b>${esc(grant.email)}</b>` : ""}.`,
        "Календар, пошта, Диск, Таблиці й Документи працюють від вашого імені.",
        ...(missing.length
          ? ["", "⚠️ <b>Не поставлено галочки:</b>", ...missing.map((m) => `• ${esc(m)}`), "", "Перепідключіть Google і натисніть «Вибрати все»."]
          : []),
      ].join("\n"),
      keyboard: [[{ text: missing.length ? "🔄 Підключити з усіма галочками" : "🔄 Перепідключити Google", url: await connectLink(env) }], back],
    };
  }
  if (googleConfigured(env)) {
    const project = env.GOOGLE_PROJECT_ID ? ` (проєкт ${esc(env.GOOGLE_PROJECT_ID)})` : "";
    const desktop = env.GOOGLE_OAUTH_MODE === "desktop";
    return {
      html: [
        "🔗 <b>Google — крок 2 із 2: увійдіть у Google</b>",
        "",
        `✅ Файл Google-клієнта є${project}.`,
        "",
        "1. Натисніть «Увійти в Google» і оберіть акаунт.",
        "2. На екрані з дозволами — <b>«Вибрати все»</b> → Продовжити. Якщо Google пише «застосунок не перевірено» — «Додатково» → «Перейти»: це ваш бот.",
        ...(desktop
          ? ["3. Браузер покаже помилку на адресі <code>http://127.0.0.1…</code> — так і треба. <b>Скопіюйте цю адресу й надішліть сюди.</b>"]
          : ["3. Google поверне вас назад, я напишу «✅ Google підключено»."]),
        "",
        `${video}<i>Інший файл клієнта? Просто надішліть його сюди.</i>`,
      ].join("\n"),
      keyboard: [[{ text: "🔗 Увійти в Google", url: await connectLink(env) }], back],
    };
  }
  return {
    html: [
      "🔗 <b>Google — крок 1 із 2: файл Google-клієнта</b>",
      "",
      video +
        `1. ${a("https://console.cloud.google.com/projectcreate", "Створіть проєкт")} у Google Cloud (будь-яка назва).`,
      `2. Увімкніть API (кожне — <b>Enable</b>): ${a(api("calendar-json.googleapis.com"), "Calendar")}, ${a(api("gmail.googleapis.com"), "Gmail")}, ${a(api("drive.googleapis.com"), "Drive")}, ${a(api("sheets.googleapis.com"), "Sheets")}, ${a(api("docs.googleapis.com"), "Docs")}, ${a(api("pubsub.googleapis.com"), "Cloud Pub/Sub")}.`,
      `3. ${a("https://console.cloud.google.com/auth/overview", "Google Auth Platform")} → Get started: назва AI-secretary, ваша пошта; Audience — Internal (акаунт компанії) або External (Gmail), для External потім <b>Publish app</b>.`,
      `4. ${a("https://console.cloud.google.com/auth/clients", "Clients")} → <b>Create client</b> → тип <b>Desktop app</b> → Create → <b>Download JSON</b>.`,
      "",
      "📎 <b>Надішліть цей файл</b> (<code>client_secret_….json</code>) сюди, у чат. Я перевірю його, збережу зашифрованим і видалю з чату — і дам кнопку «Увійти в Google».",
    ].join("\n"),
    keyboard: [back],
  };
}

async function bitrixTab(env: Env): Promise<View> {
  const source = integrationSource(env, "bitrix");
  if (bitrixConfigured(env)) {
    return {
      html: "📋 <b>Bitrix24</b>\n\n✅ Підключено. Пишіть «мої задачі», «що горить?», «постав Івану задачу …», «напиши в чат … що …», «напиши Олені …» або відкрийте /bitrix.\n\nЗакривати, змінювати чи видаляти задачі я не можу — лише читаю, коментую й створюю нові. Пишу в задачі, чати й особисті — лише після вашого «так».",
      keyboard: [...(source === "settings" ? [[{ text: "❌ Відключити Bitrix24", callback_data: "set:off:bitrix" }]] : []), back],
    };
  }
  return {
    html: [
      "📋 <b>Bitrix24 — задачі</b>",
      "",
      videoLine("bitrix", await guideVideo(env, "bitrix")) + "1. У Bitrix24: <b>Розробникам → Інше → Вхідний вебхук</b>.",
      "2. Права: <b>Задачі</b>, <b>Користувачі</b>, <b>Чат і повідомлення</b> → <b>Зберегти</b>.",
      "3. Скопіюйте «Вебхук для виклику REST API» (<code>https://ваш-портал.bitrix24.ua/rest/1/…/</code>).",
      "4. Натисніть кнопку нижче й надішліть адресу у відповідь.",
    ].join("\n"),
    keyboard: [[{ text: "🔗 Надіслати вебхук", callback_data: "set:on:bitrix" }], back],
  };
}

function zoomTab(env: Env): View {
  const source = integrationSource(env, "zoom");
  if (zoomConfigured(env)) {
    return {
      html: "🎥 <b>Zoom</b>\n\n✅ Підключено. Скажіть «зустріч у Zoom …» — посилання створю сам.",
      keyboard: [...(source === "settings" ? [[{ text: "❌ Відключити Zoom", callback_data: "set:off:zoom" }]] : []), back],
    };
  }
  return {
    html: [
      "🎥 <b>Zoom — зустрічі в Zoom</b> (необовʼязково: без нього — Google Meet)",
      "",
      `1. ${a("https://marketplace.zoom.us/develop/create", "Zoom Marketplace")} → <b>Develop → Build App → Server-to-Server OAuth</b>.`,
      "2. Scopes: <b>meeting:write:admin</b> → <b>Activate</b>.",
      "3. Натисніть кнопку нижче й надішліть трьома рядками: Account ID, Client ID, Client Secret.",
    ].join("\n"),
    keyboard: [[{ text: "🔗 Надіслати ключі Zoom", callback_data: "set:on:zoom" }], back],
  };
}

export async function tabView(env: Env, tab: Tab): Promise<View> {
  const view = tab === "google" ? await googleTab(env) : tab === "bitrix" ? await bitrixTab(env) : zoomTab(env);
  // Google and Bitrix24 have a guide video: a reply with another video replaces it.
  return tab === "zoom" ? view : { ...view, html: guideRef(tab) + view.html };
}

/** A tab as a new message (from /start, a link or after a step), with the owner's own video file if any. */
export async function sendTab(env: Env, chatId: number, tab: Tab): Promise<void> {
  if (tab !== "zoom") await sendVideoFile(env, chatId, tab, await guideVideo(env, tab));
  const view = await tabView(env, tab);
  await new Telegram(env).send(chatId, view.html, { keyboard: view.keyboard });
}
