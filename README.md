# 🗓 AI-secretary

Особистий секретар у Telegram: зустрічі в Google Calendar, пошта, документи, нотатки, Bitrix24.

<a href="#запуск"><img src="https://vercel.com/button" alt="Розгорнути на Vercel" height="40"></a>

## Запуск

Потрібні: запрошення в організацію **RibasTeam** (прийде листом), акаунти GitHub і Vercel, а також три значення —
`TELEGRAM_BOT_TOKEN` (@BotFather), `OWNER_TELEGRAM_ID` (@userinfobot), `OPENROUTER_API_KEY` (openrouter.ai/keys).

1. **Прийміть запрошення** в RibasTeam (лист від GitHub або <https://github.com/orgs/RibasTeam/invitation>).
2. **[Створіть свою копію](https://github.com/new?template_name=aisecretary&template_owner=RibasTeam)** →
   Owner — **ваш акаунт** → **Private** → **Create repository**.
3. **[Встановіть Mem341 Bot Updater](https://github.com/apps/mem341-bot-updater/installations/new)** → ваш акаунт →
   **Only select repositories** → лише вашу копію → **Install**. Так копія отримуватиме оновлення.
4. **[Розгорніть на Vercel](https://vercel.com/new)** → **Import** вашої копії → вкажіть три значення → **Deploy**.
5. Відкрийте `https://<адреса-проєкту>.vercel.app/api/setup` і напишіть боту `/start` — Google підключається в боті.

Оновлення приходять самі: нова версія записується у вашу копію, Vercel її розгортає. Ключі й налаштування не
змінюються — вони у Vercel і в Telegram, не в репозиторії.

> Кнопка Vercel «Deploy» в один клік працює лише з публічним кодом, тому тут — імпорт вашої приватної копії.

Детальніше про значення й необовʼязкові можливості — [docs/what-you-need.md](docs/what-you-need.md).

<details>
<summary>Для власника репозиторію</summary>

- **Settings → General → Template repository** — увімкнено (без цього крок 2 відкриває порожню форму).
- Застосунок **Mem341 Bot Updater** встановлено на RibasTeam з доступом до `aisecretary` (ним перевіряється, хто має доступ).
- Секрети Actions: `UPDATER_APP_ID`, `UPDATER_APP_PRIVATE_KEY`.
- Після кожного зеленого CI на `main` (і щодня) `.github/workflows/sync.yml` записує `main` у копії, де встановлено
  застосунок. Лише якщо копія **приватна**, належить **особистому** акаунту і її власник **має доступ** до цього
  репозиторію; інші пропускаються. Забрали доступ — оновлення цій копії припиняються.
- Запустити вручну: **Actions → Update the copies → Run workflow**.

</details>

> 🤖 AI-агент: читай [AGENTS.md](AGENTS.md).
