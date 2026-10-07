# 🗓 AI-secretary

Особистий секретар у Telegram: зустрічі в Google Calendar, пошта, документи, нотатки, Bitrix24.

## Як розгорнути собі

Потрібні безкоштовні акаунти [GitHub](https://github.com/signup) і [Vercel](https://vercel.com/signup). ~10 хвилин.

### Крок 1. Три значення

| Що | Де взяти |
|---|---|
| Токен бота | Telegram → [@BotFather](https://t.me/BotFather) → `/newbot` → назва → імʼя на `…bot` → скопіюйте токен `123456:AA…` |
| Ваш Telegram ID | Telegram → [@userinfobot](https://t.me/userinfobot) → `/start` → число `Id` |
| Ключ OpenRouter | <https://openrouter.ai/keys> → **Create Key** → скопіюйте `sk-or-v1-…` (поповніть баланс на $5–10) |

### Крок 2. Fork

1. Відкрийте <https://github.com/Mem341/aisecretary/fork>.
2. Нічого не змінюйте → **Create fork**.

### Крок 3. Ключ GitHub — щоб бот оновлювався сам

1. Відкрийте <https://github.com/settings/personal-access-tokens/new>.
2. **Token name:** `aisecretary-update`. **Expiration:** найдовший строк.
3. **Repository access** → **Only select repositories** → виберіть **свій** форк `<ваш-логін>/aisecretary`.
4. **Permissions** → **Add permissions**:
   - **Contents** → **Read and write**
   - **Workflows** → **Read and write**
5. **Generate token** → скопіюйте `github_pat_…` (його покажуть лише раз).

### Крок 4. Резервне оновлення в GitHub

1. У своєму форку вкладка **Actions** → **I understand my workflows, go ahead and enable them**.
2. Зліва **Sync from upstream** → **Enable workflow**.

### Крок 5. Vercel

1. Відкрийте <https://vercel.com/new> → **Import** навпроти свого форка `aisecretary`.
2. Розгорніть **Environment Variables** і додайте:

| Name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | токен бота з кроку 1 |
| `OWNER_TELEGRAM_ID` | ваш Telegram ID з кроку 1 |
| `OPENROUTER_API_KEY` | ключ OpenRouter з кроку 1 |
| `GITHUB_TOKEN` | ключ GitHub з кроку 3 |

3. **Deploy** → дочекайтеся «Congratulations».

### Крок 6. Запуск

1. Відкрийте `https://<назва-проєкту>.vercel.app/api/setup` — відкриється ваш бот.
2. Напишіть йому `/start` → **⚙️ Налаштувати** → Google підключається прямо в боті (є відео).

Готово. Оновлення приходять самі: бот бере нову перевірену версію, Vercel її розгортає, бот пише «🆕 Бот оновлено».

## Необовʼязкові змінні Vercel

Додаються так само: Vercel → проєкт → **Settings → Environment Variables** → **Redeploy**.

| Name | Що дає |
|---|---|
| `TIMEZONE` | часовий пояс, за замовчуванням `Europe/Kyiv` (напр. `Europe/Warsaw`) |
| `OWNER_NAME`, `OWNER_POSITION`, `OWNER_PHONE` | ваш підпис в описі зустрічей |
| `DEFAULT_DURATION_MIN` | тривалість зустрічі, хв (за замовчуванням 60) |
| `DEFAULT_FORMAT` | `offline` / `google_meet` / `zoom` |
| `DEFAULT_ADDRESS` | адреса для офлайн-зустрічей |

Google, Bitrix24 і Zoom підключаються в боті (`/settings`), не змінними. Повний список — [.env.example](.env.example).

## Важливо

- **Не змінюйте код у своєму форку** — інакше оновлення зламаються. Усе своє — змінні Vercel і `/settings` у боті.
- Ключі нікому не надсилайте й не вставляйте в код — вони лише у вашому Vercel.

Детальніше — [docs/what-you-need.md](docs/what-you-need.md).

> 🤖 AI-агент: читай [AGENTS.md](AGENTS.md).
