import { bitrixConfigured, type Env } from "../env";
import { loadOwnerSettings, type OwnerSettings, saveOwnerSettings } from "../google/oauth";
import { integrationSource } from "../integrations";
import { esc, Telegram } from "../telegram/api";
import { hiddenData, readHidden } from "../telegram/hidden";
import type { InlineKeyboard, TgMessage } from "../telegram/types";

/**
 * «📖 Інструкції» (/help, /settings): step-by-step guides inside the bot — Google (which APIs to enable and how to
 * connect), Telegram (the bot itself and how to use it), Bitrix24. The owner adds a video to a guide by replying to it
 * with the video (or a link); it is kept with the owner's settings in the pinned message (no database) and shown
 * together with the guide from then on.
 */

export const GUIDES = { google: "Google", telegram: "Telegram", bitrix: "Bitrix24" } as const;
export type Guide = keyof typeof GUIDES;

/** A guide's video: a Telegram file (f, sent as t) or a link (u). */
export interface GuideVideo {
  f?: string;
  t?: "video" | "animation" | "document";
  u?: string;
}

interface GuideRef {
  k: "guide";
  w: Guide;
}

/** The project's video tutorials (Google Drive); the owner's own video, if added, is shown instead. */
export const DEFAULT_VIDEOS: Record<Guide, string> = {
  google: "https://drive.google.com/file/d/1o1UOKdoZSm1j-d3cSjSd4-tVVB0HjeGh/view",
  telegram: "https://drive.google.com/file/d/1YJVHDBX5czzyU7kQ6S38jnNlzopAKCW3/view",
  bitrix: "https://drive.google.com/file/d/1B2s1FbKSfogaEgv4L7fSpiqF-AbX0nq7/view",
};
export const VIDEOS_FOLDER = "https://drive.google.com/drive/folders/1VwJAJykWX4eBCpYlny6cfiLFqd3ESBKL";

export const GUIDE_MENU: InlineKeyboard = [
  (Object.keys(GUIDES) as Guide[]).map((w) => ({ text: `📖 ${GUIDES[w]}`, callback_data: `guide:${w}` })),
];

const api = (env: Env, id: string) =>
  `https://console.cloud.google.com/apis/library/${id}${env.GOOGLE_PROJECT_ID ? `?project=${encodeURIComponent(env.GOOGLE_PROJECT_ID)}` : ""}`;
const link = (href: string, text: string) => `<a href="${esc(href)}">${esc(text)}</a>`;

function googleGuide(env: Env): string {
  return [
    "📖 <b>Google: що увімкнути й як підключити</b>",
    "",
    "<b>1. Проєкт.</b> " + link("https://console.cloud.google.com/projectcreate", "Створіть проєкт") + " з будь-якою назвою й переконайтеся, що вгорі вибрано саме його.",
    "",
    `<b>2. Увімкніть 6 API</b> — відкрийте кожне й натисніть <b>Enable</b>:${env.GOOGLE_PROJECT_ID ? " (посилання вже ведуть у ваш проєкт)" : ""}`,
    `• ${link(api(env, "calendar-json.googleapis.com"), "Google Calendar API")} — зустрічі, розклад, запрошення`,
    `• ${link(api(env, "gmail.googleapis.com"), "Gmail API")} — пошта й сигнали нагадувань`,
    `• ${link(api(env, "drive.googleapis.com"), "Google Drive API")} — ваші файли й памʼять розмови`,
    `• ${link(api(env, "sheets.googleapis.com"), "Google Sheets API")} — таблиці: читати, додавати рядки`,
    `• ${link(api(env, "docs.googleapis.com"), "Google Docs API")} — документи: створювати, дописувати`,
    `• ${link(api(env, "pubsub.googleapis.com"), "Cloud Pub/Sub API")} — Google будить бота: нові листи, нагадування, ранковий звіт`,
    "",
    "<b>3. Екран згоди.</b> " + link("https://console.cloud.google.com/auth/overview", "Google Auth Platform") + " → <b>Get started</b>:",
    "• назва — AI-secretary, пошта — ваша;",
    "• Audience: акаунт компанії → <b>Internal</b>, звичайний Gmail → <b>External</b>;",
    "• для External: " + link("https://console.cloud.google.com/auth/audience", "Audience") + " → <b>Publish app</b> (інакше доступ злітає кожні 7 днів).",
    "",
    "<b>4. Клієнт.</b> " + link("https://console.cloud.google.com/auth/clients", "Clients") + " → <b>Create client</b> → тип <b>Desktop app</b> → Create → <b>Download JSON</b>. <b>Надішліть цей файл сюди, у чат</b> — я збережу його зашифрованим і видалю з чату.",
    "",
    "<b>5. У боті.</b> /start → «Підключити Google» → оберіть акаунт → <b>«Вибрати все» (Select all)</b> → Продовжити. Браузер покаже помилку на адресі <code>127.0.0.1…</code> — так і треба: скопіюйте адресу й надішліть сюди.",
    "",
    "<b>Якщо щось не так</b>",
    "• «403 access_denied … тестується» → Audience → Publish app;",
    "• не приходять нагадування → /settings → ⏰ → «🔁 Налаштувати»;",
    "• «не поставлено галочки» → підключіть Google ще раз і натисніть «Вибрати все».",
    "",
    "Google пише, що бот зможе «видаляти» файли, — це стандартний текст дозволу. Бот нічого не видаляє: таких команд у нього немає.",
  ].join("\n");
}

function telegramGuide(env: Env): string {
  return [
    "📖 <b>Telegram: бот і як ним користуватися</b>",
    "",
    "<b>Створити бота</b>",
    "1. " + link("https://t.me/BotFather", "@BotFather") + " → <code>/newbot</code> → імʼя → username, що закінчується на <code>bot</code>.",
    "2. BotFather надішле <b>токен</b> (<code>7412345678:AAH…</code>) — це <code>TELEGRAM_BOT_TOKEN</code> у Vercel.",
    "3. Ваш <b>ID</b>: напишіть " + link("https://t.me/userinfobot", "@userinfobot") + " — потрібне число, це <code>OWNER_TELEGRAM_ID</code>.",
    "4. За бажанням у BotFather: <code>/setuserpic</code> — фото, <code>/setdescription</code> — опис.",
    `5. Після розгортання відкрийте ${link(`${env.PUBLIC_URL}/api/setup`, `${env.PUBLIC_URL.replace(/^https:\/\//, "")}/api/setup`)} — бот підключиться до Telegram і відкриється чат.`,
    "",
    "<b>Як користуватися</b>",
    "• Пишіть як людині — текстом, голосовим, скріншотом або пересилайте переписку.",
    "• Відповідайте (reply) на моє повідомлення про зустріч, лист чи задачу — я зрозумію, про що мова.",
    "• Коли я щось питаю — просто відповідайте, я продовжу ту саму дію.",
    "• Не відкріплюйте закріплене повідомлення «🔐 Google підключено»: у ньому зашифровані доступи й налаштування.",
    "• Команди: /settings — налаштування, /bitrix — задачі, /reset — почати розмову заново, /help — довідка.",
  ].join("\n");
}

function bitrixGuide(env: Env): string {
  return [
    "📖 <b>Bitrix24: як підключити</b>",
    ...(bitrixConfigured(env) ? ["", "✅ Bitrix24 уже підключено."] : []),
    "",
    "1. У Bitrix24: <b>Розробникам → Інше → Вхідний вебхук</b>.",
    "2. Права доступу: <b>Задачі</b>, <b>Користувачі</b>, <b>Чат і повідомлення</b> → <b>Зберегти</b>.",
    "3. Скопіюйте «Вебхук для виклику REST API» — вигляду <code>https://ваш-портал.bitrix24.ua/rest/1/abc123…/</code>.",
    "4. /settings → «🔗 Підключити Bitrix24» → надішліть адресу у відповідь. Я перевірю її, збережу зашифрованою й видалю ваше повідомлення.",
    "",
    "<b>Що вмію</b>",
    "• «мої задачі», «що горить?», «що із задачею про звіт?» — стан беру з чату задачі;",
    "• «постав Івану задачу … до пʼятниці, я спостерігач» — превʼю, після «так» створю;",
    "• /bitrix — списки, аналітика, Excel-звіт.",
    "",
    "Закривати, змінювати чи видаляти задачі я не можу — лише читаю, коментую й створюю нові.",
  ].join("\n");
}

const TEXT: Record<Guide, (env: Env) => string> = { google: googleGuide, telegram: telegramGuide, bitrix: bitrixGuide };

export async function showGuideMenu(env: Env, chatId: number): Promise<void> {
  await new Telegram(env).send(chatId, "📖 <b>Інструкції</b>\n\nОберіть, що налаштувати:", { keyboard: GUIDE_MENU });
}

/** Sends a guide: its video first (when the owner added one), then the steps. */
export async function showGuide(env: Env, chatId: number, w: Guide): Promise<void> {
  const tg = new Telegram(env);
  const video: GuideVideo = ((await loadOwnerSettings(env).catch((): OwnerSettings => ({}))).gv ?? {})[w] ?? { u: DEFAULT_VIDEOS[w] };
  if (video?.f) {
    const method = video.t === "animation" ? "sendAnimation" : video.t === "document" ? "sendDocument" : "sendVideo";
    const field = video.t === "animation" ? "animation" : video.t === "document" ? "document" : "video";
    await tg.call(method, { chat_id: chatId, [field]: video.f, caption: `▶️ Відео: ${GUIDES[w]}` }).catch(() => undefined);
  }
  const keyboard: InlineKeyboard = [];
  if (video?.u) keyboard.push([{ text: "▶️ Дивитися відео", url: video.u }]);
  if (w === "bitrix" && !bitrixConfigured(env) && integrationSource(env, "bitrix") !== "variable") {
    keyboard.push([{ text: "🔗 Підключити Bitrix24", callback_data: "set:on:bitrix" }]);
  }
  await tg.send(chatId, hiddenData({ k: "guide", w } satisfies GuideRef) + TEXT[w](env), keyboard.length ? { keyboard } : {});
}

/**
 * The owner's reply to a guide with a video, a GIF, a video file or a link: kept as that guide's video.
 * «прибери відео» removes it. False when the message is not such a reply.
 */
export async function handleGuideReply(env: Env, msg: TgMessage): Promise<boolean> {
  const ref = readHidden<GuideRef>(msg.reply_to_message);
  if (ref?.k !== "guide" || !(ref.w in GUIDES)) return false;
  const text = (msg.text ?? msg.caption ?? "").trim();
  const url = /https?:\/\/\S+/.exec(text)?.[0];
  let video: GuideVideo | null | undefined;
  if (msg.video) video = { f: msg.video.file_id, t: "video" };
  else if (msg.animation) video = { f: msg.animation.file_id, t: "animation" };
  else if (msg.document?.mime_type?.startsWith("video/")) video = { f: msg.document.file_id, t: "document" };
  else if (url) video = { u: url };
  // Only a plain «прибери відео»; any other text in reply to a guide is a question for the agents.
  else if (/(прибер|видал|удал|убер)\S*\s+(це\s+|это\s+)?(відео|видео|video)/i.test(text)) video = null;
  if (video === undefined) return false;
  const settings = await loadOwnerSettings(env);
  const gv = { ...(settings.gv ?? {}) };
  if (video) gv[ref.w] = video;
  else delete gv[ref.w];
  await saveOwnerSettings(env, { ...settings, gv });
  await new Telegram(env).send(
    msg.chat.id,
    video ? `✅ Відео додано до інструкції «${GUIDES[ref.w]}». Тепер воно показується разом з нею.` : `Відео з інструкції «${GUIDES[ref.w]}» прибрано.`,
  );
  return true;
}
