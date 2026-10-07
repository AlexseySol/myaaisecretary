import { bitrixConfigured, type Env } from "../env";
import type { InlineKeyboard } from "../telegram/types";
import { sendTab } from "./tabs";
import { hasGoogleAuth } from "../google/oauth";
import { esc, Telegram } from "../telegram/api";
import { refreshCommands } from "./commands";
import type { User } from "./owner";

/** «Підключити Google» anywhere: the Google tab, at the step the owner is on. */
export async function sendConnectGoogle(env: Env): Promise<void> {
  await sendTab(env, env.OWNER_TELEGRAM_ID, "google");
}

/** What the bot can do and how to work with it — the first thing a new owner sees (and «💡 Що я вмію»). */
export function tourText(name?: string | null): string {
  return [
    name ? `👋 Вітаю, ${esc(name)}! Я ваш AI-секретар.` : "👋 Вітаю! Я ваш AI-секретар.",
    "",
    "<b>Що я вмію</b>",
    "📅 <b>Календар</b> — ставлю зустрічі з Google Meet чи Zoom, показую розклад і вільний час, переношу й скасовую; про нові запрошення й зміни пишу одразу, з кнопками ✅ / ❌.",
    "📧 <b>Пошта</b> — шукаю, читаю, пишу й відповідаю на листи; про нові листи повідомляю одразу.",
    "📁 <b>Документи</b> — знаходжу й читаю файли на Google Диску, веду таблиці й документи, читаю PDF, Word, Excel.",
    "📋 <b>Задачі Bitrix24</b> — показую, аналізую, ставлю задачі людям за імʼям, роблю Excel-звіт.",
    "📒 <b>Нотатки</b> — записую думки, справи й нагадування «нагадай мені о…» в таблицю «Нотатки» на вашому Google Диску; нагадую в Telegram у потрібний час.",
    "⏰ <b>Нагадування</b> перед зустрічами й ☀️ <b>ранковий звіт</b> — у ваш час.",
    "",
    "<b>Як зі мною працювати</b>",
    "• Пишіть як людині — текстом, голосовим, скріншотом або пересилайте переписку.",
    "• Відповідайте (reply) на моє повідомлення про зустріч, лист чи задачу — я зрозумію, про що мова.",
    "• Якщо я щось питаю — просто відповідайте, я продовжу ту саму дію.",
    "• Лист, коментар чи нову задачу надсилаю лише після вашого «так». Нічого не видаляю без прямого прохання.",
    "",
    "<b>З чого почати:</b> ⚙️ Налаштування → 🔗 Google (2 кроки, ~5 хвилин, є відео).",
  ].join("\n");
}

/** /start — first what the bot can do; then the settings, where each connection is its own tab. */
export async function startOnboarding(env: Env, user: User): Promise<void> {
  const tg = new Telegram(env);
  await refreshCommands(env);
  if (!(await hasGoogleAuth(env))) {
    await tg.send(user.tg_id, tourText(user.full_name), { keyboard: [[{ text: "⚙️ Налаштувати", callback_data: "set:open" }]], removeKeyboard: false });
    return;
  }
  const hello = user.full_name ? `👋 Вітаю, ${esc(user.full_name)}!` : "👋 Вітаю!";
  await tg.send(user.tg_id, `${hello}\n\n${helpText()}`, { keyboard: mainMenu(env) });
}

export function helpText(): string {
  return [
    "🗓 <b>AI-секретар</b>",
    "<i>Пишіть як людині — текстом, голосом, скріншотом чи пересланою перепискою.</i>",
    "",
    "📅 <b>Календар</b>",
    "<blockquote>Зустріч з Іваном завтра о 14 в Zoom\nЩо в мене сьогодні?\nПеренеси стендап на 15:00</blockquote>",
    "📧 <b>Пошта</b>",
    "<blockquote>Перевір пошту\nЛисти від Марії за тиждень\nВідповідай, що я погоджуюсь</blockquote>",
    "📒 <b>Нотатки</b>",
    "<blockquote>Запиши ідею: …\nНагадай мені завтра о 9 подзвонити в банк\nЩо я записував про звіт?</blockquote>",
    "💬 <b>Відповідайте (reply)</b> на моє повідомлення — «скасуй», «хто буде?», «додай нотатку: …».",
    "🔔 Про запрошення, зміни й нові листи пишу одразу; ☀️ щоранку — план на день.",
  ].join("\n");
}

/** The buttons under the main menu: everything the commands open, one tap each. */
export function mainMenu(env: Env): InlineKeyboard {
  return [
    [
      { text: "📒 Нотатки", callback_data: "menu:notes" },
      ...(bitrixConfigured(env) ? [{ text: "📋 Bitrix24", callback_data: "menu:bitrix" }] : []),
    ],
    [
      { text: "⚙️ Налаштування", callback_data: "set:open" },
      { text: "📖 Інструкції", callback_data: "guide:menu" },
    ],
    [{ text: "🧹 Почати розмову заново", callback_data: "menu:reset" }],
  ];
}
