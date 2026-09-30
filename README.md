# 🗓 AI-secretary

Особистий секретар у Telegram. Ви пишете йому як людині — текстом, голосом, скріншотом чи пересланою перепискою, —
а він веде ваш Google Calendar, Gmail і задачі Bitrix24.

> 🤖 **ШІ-агентам, які розгортають бота:** спершу прочитайте [AGENTS.md](AGENTS.md).

## Як це працює

- **Одна копія — одна людина.** Кожен розгортає власного бота на Vercel. Бот відповідає лише власнику
  (`OWNER_TELEGRAM_ID`), усіх інших мовчки ігнорує.
- **ШІ-агенти.** Запит іде агенту календаря, пошти чи задач; незрозумілий — розбирає Supervisor. Агенти самі
  викликають Google Calendar, Gmail і Bitrix24. Моделі — через OpenRouter.
- **Календар.** Створює зустрічі з Google Meet чи Zoom, показує розклад, переносить і скасовує. Нові запрошення,
  зміни й відповіді гостей приходять одразу, з кнопками ✅ / ❌.
- **Пошта.** Шукає, читає, пише й відповідає. Надсилає лише після вашого «так». Про нові листи повідомляє одразу.
- **Google Диск, Таблиці й Документи.** Знаходить і читає файли, створює документи й таблиці, додає рядки й текст,
  переміщує й відкриває доступ. Нічого не видаляє. Читає PDF, Word, Excel і CSV — надіслані в чат і вкладені в листи.
- **Задачі Bitrix24.** Показує, аналізує за чатом задачі, ставить нові людям за імʼям, робить Excel-звіт. Закривати,
  змінювати чи видаляти задачі не може.
- **Нагадування й ранковий звіт** — у ваш час. Годинник — сам Google: без cron і сторонніх сервісів.
- **Памʼять.** Одна розмова до 100 питань-відповідей і нотатка фактів — у прихованій папці бота на вашому Google Drive.
- **Без бази даних.** Доступ до Google зашифрований в одному закріпленому повідомленні чату з ботом; решта — у самих
  Google Calendar, Gmail і Drive.
- **Оновлення.** Після кожного оновлення бот сам пише, що нового, і чи треба щось зробити.

<a id="deploy"></a>

## Запуск

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FMem341%2FAI-secretary&env=OWNER_TELEGRAM_ID%2CTELEGRAM_BOT_TOKEN%2COPENROUTER_API_KEY&envDescription=Your+numeric+Telegram+ID+%28%40userinfobot%29%2C+bot+token+%28%40BotFather%29%2C+OpenRouter+API+key&envLink=https%3A%2F%2Fgithub.com%2FMem341%2FAI-secretary%23deploy&project-name=ai-secretary&repository-name=ai-secretary)

Потрібні три речі — токен бота, ваш Telegram ID і ключ OpenRouter. Google підключається потім у самому боті:
напишіть йому `/start`. Де взяти кожну річ (і все необовʼязкове) — **[docs/what-you-need.md](docs/what-you-need.md)**.

## Розробка

```bash
npm ci && npm run typecheck && npm test
```

Node.js 22 · TypeScript · Vercel Functions · [MIT](LICENSE)
