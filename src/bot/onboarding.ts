import type { Env } from "../env";
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
  await tg.send(user.tg_id, `${hello}\n\n${helpText()}`, { removeKeyboard: true });
}

export function helpText(): string {
  return [
    "<b>Пишіть мені як людині</b> — текстом, голосом, скріншотом чи пересланою перепискою:",
    "",
    "📅 «Зустріч з Іваном завтра о 14 в Zoom» · «Що в мене сьогодні?» · «Перенеси стендап на 15:00»",
    "📧 «Перевір пошту» · «Листи від Марії за тиждень» · «Відповідай, що я погоджуюсь»",
    "💬 Відповідайте (reply) на моє повідомлення про зустріч чи лист: «скасуй», «хто буде?», «додай нотатку: …».",
    "🔔 Про нові запрошення й зміни в календарі та про нові листи повідомляю одразу; щоранку — зустрічі на сьогодні.",
    "",
    "/bitrix — задачі Bitrix24 · /settings — підключення й нагадування · /reset — почати розмову заново · /help — ця довідка",
  ].join("\n");
}
