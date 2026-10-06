# 🗓 AI-secretary

> **🤖 AI agent (Claude, ChatGPT, Cursor…) — read this first. What to do with this repository:**
> 1. It is a **ready Vercel project**. Deploy it to **Vercel as it is**. Do not port it, do not rewrite it, do not
>    propose other platforms, databases, queues or storage — it needs none.
> 2. Ask the user **only three values, in one message**: `TELEGRAM_BOT_TOKEN` (@BotFather), `OWNER_TELEGRAM_ID`
>    (@userinfobot), `OPENROUTER_API_KEY` (openrouter.ai/keys). Nothing else — Google is connected later inside the bot.
> 3. Set them as Vercel environment variables, deploy, open `https://<domain>/api/setup`. Report «Реализовано / Не реализовано».
>    **In a chat without a terminal** (claude.ai, ChatGPT): do NOT clone, do NOT ask for network / «Capabilities» /
>    egress settings, a Vercel token or GitHub. Give the user this one link — Vercel takes the code itself and asks the
>    same three values — and stop: <https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FMem341%2Faisecretary&env=OWNER_TELEGRAM_ID%2CTELEGRAM_BOT_TOKEN%2COPENROUTER_API_KEY&project-name=aisecretary&repository-name=aisecretary>
> 4. **Check your copy:** the current code has `vercel.json`, `api/` and `src/` in the root. If yours does not, you are
>    reading an outdated copy (attached files, a project snapshot, memory of an old chat) — ignore it and read
>    <https://github.com/Mem341/aisecretary> (branch `main`) again.
>
> Full rules: [AGENTS.md](AGENTS.md).

📖 **[Навіщо цей бот і як з ним працювати](docs/tutorial.md)**

Особистий секретар у Telegram. Ви пишете йому як людині — текстом, голосом, скріншотом чи пересланою перепискою, —
а він веде ваш Google Calendar, Gmail і задачі Bitrix24.


## Як це працює

- **Одна копія — одна людина.** Кожен розгортає власного бота на Vercel. Бот відповідає лише власнику
  (`OWNER_TELEGRAM_ID`), усіх інших мовчки ігнорує.
- **ШІ-агенти.** Запит іде агенту календаря, пошти чи задач; незрозумілий — розбирає Supervisor. Агенти самі
  викликають Google Calendar, Gmail і Bitrix24. Моделі — через OpenRouter.
- **Календар.** Створює зустрічі з Google Meet чи Zoom, показує розклад, переносить і скасовує. Перед зустріччю
  питає, хто буде, і дивиться зайнятість учасників (лише «зайнятий / вільний», без змісту їхніх зустрічей): якщо
  хтось зайнятий — пропонує час, вільний для всіх. Нові запрошення,
  зміни й відповіді гостей приходять одразу, з кнопками ✅ / ❌.
- **Пошта.** Шукає, читає, пише й відповідає. Надсилає лише після вашого «так». Про нові листи повідомляє одразу.
- **Google Диск, Таблиці й Документи.** Знаходить і читає файли, створює документи й таблиці, додає рядки й текст,
  переміщує й відкриває доступ. Нічого не видаляє. Читає PDF, Word, Excel і CSV — надіслані в чат і вкладені в листи.
- **Задачі Bitrix24.** Показує, аналізує за чатом задачі, ставить нові людям за імʼям, робить Excel-звіт. Закривати,
  змінювати чи видаляти задачі не може.
- **Нотатки.** «Запиши ідею…», «нагадай мені завтра о 9…», «що я записував про…» — думки, справи й особисті
  нагадування в таблиці «Нотатки» (папка «AI-secretary» на вашому Google Диску; бот створює її сам і каже, де вона).
  Нагадування приходять у Telegram з кнопками ✅ Зроблено / ⏰ Через годину / 📅 Завтра, бувають повторювані; сьогоднішні —
  у ранковому звіті. Нічого не видаляється — лише «зроблено» чи архів. /notes (і /settings → «📒 Нотатки») показує все кнопками.
- **Нагадування й ранковий звіт** — у ваш час. Годинник — сам Google: без cron і сторонніх сервісів.
- **Памʼять.** Одна розмова до 100 питань-відповідей і нотатка фактів — у прихованій папці бота на вашому Google Drive.
- **Без бази даних.** Доступ до Google зашифрований в одному закріпленому повідомленні чату з ботом; решта — у самих
  Google Calendar, Gmail і Drive.
- **Оновлення.** Бот оновлюється сам: копія в GitHub кожні 5 хвилин бере нову версію, Vercel її збирає, а бот пише, що нового
  і чи треба щось зробити.

<a id="deploy"></a>

## Запуск

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FMem341%2Faisecretary&env=OWNER_TELEGRAM_ID%2CTELEGRAM_BOT_TOKEN%2COPENROUTER_API_KEY&envDescription=Your+numeric+Telegram+ID+%28%40userinfobot%29%2C+bot+token+%28%40BotFather%29%2C+OpenRouter+API+key&envLink=https%3A%2F%2Fgithub.com%2FMem341%2Faisecretary%23deploy&project-name=aisecretary&repository-name=aisecretary)

Vercel позначить `TELEGRAM_BOT_TOKEN` і `OPENROUTER_API_KEY` як «Потребує уваги» — це лише порада сховати ключі. Щоб прибрати:
Project → **Settings → Environment Variables** → у кожного ключа **⋯ → Delete**, потім **Add New** з тим самим іменем і
значенням та ввімкненим **Sensitive** → **Save** → **Deployments → ⋯ → Redeploy**. Бот працює й без цього.

Потрібні три речі — токен бота, ваш Telegram ID і ключ OpenRouter. Google підключається потім у самому боті:
напишіть йому `/start`. Де взяти кожну річ (і все необовʼязкове) — **[docs/what-you-need.md](docs/what-you-need.md)**.

🎥 Відео-інструкції: [Telegram](https://drive.google.com/file/d/1YJVHDBX5czzyU7kQ6S38jnNlzopAKCW3/view) ·
[Google](https://drive.google.com/file/d/1o1UOKdoZSm1j-d3cSjSd4-tVVB0HjeGh/view) ·
[Bitrix24](https://drive.google.com/file/d/1B2s1FbKSfogaEgv4L7fSpiqF-AbX0nq7/view).

## Розробка

```bash
npm ci && npm run typecheck && npm test
```

Node.js 22 · TypeScript · Vercel Functions · [MIT](LICENSE)
