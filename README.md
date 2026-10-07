# 🗓 AI-secretary

Особистий секретар у Telegram: зустрічі в Google Calendar, пошта, документи, нотатки, Bitrix24.

## Як розгорнути собі

Потрібні акаунти GitHub і [Vercel](https://vercel.com/signup) (безкоштовні) і три значення:
`TELEGRAM_BOT_TOKEN` (@BotFather), `OWNER_TELEGRAM_ID` (@userinfobot), `OPENROUTER_API_KEY` (openrouter.ai/keys).

1. **Fork:** на цій сторінці вгорі **Fork** → **Create fork**.
2. **Увімкніть оновлення:** у своєму форку вкладка **Actions** → **I understand my workflows, go ahead and enable them**
   → зліва **Sync from upstream** → **Enable workflow**.
3. **Vercel:** <https://vercel.com/new> (**Add New → Project**) → **Import** свого форка.
4. **Змінні:** у **Environment Variables** впишіть `TELEGRAM_BOT_TOKEN`, `OWNER_TELEGRAM_ID`, `OPENROUTER_API_KEY` →
   **Deploy**. Необовʼязкові (часовий пояс, моделі тощо) — у [.env.example](.env.example).
5. Відкрийте `https://<адреса-проєкту>.vercel.app/api/setup` і напишіть боту `/start` — Google підключається в боті.

**Більше нічого в коді форку не змінюйте** — інакше автооновлення зламаються. Усе своє задається змінними у Vercel і
в боті (`/settings`).

Оновлення приходять самі: форк бере нову перевірену версію звідси, Vercel її розгортає, бот пише «🆕 Бот оновлено».
Ключі й налаштування не змінюються — вони у Vercel і в Telegram.

**Надійно й одразу — ключ GitHub (1 хвилина, один раз).** Розклад GitHub у форках запускається із запізненням або
зовсім не запускається. З ключем форк оновлює сам бот (не частіше ніж раз на 15 хвилин, коли прокидається):
1. <https://github.com/settings/personal-access-tokens/new> (у своєму акаунті GitHub, де форк).
2. **Repository access → Only select repositories** → свій форк `aisecretary`.
3. **Permissions → Contents: Read and write** і **Workflows: Read and write** → **Generate token**.
4. Vercel → проєкт → **Settings → Environment Variables** → `GITHUB_TOKEN` = ключ → **Redeploy**.

Ключ лишається тільки у вашому Vercel, нікому його не надсилайте.

Детальніше — [docs/what-you-need.md](docs/what-you-need.md).

> 🤖 AI-агент: читай [AGENTS.md](AGENTS.md).
