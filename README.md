# 🗓 AI-secretary

Особистий секретар у Telegram: зустрічі в Google Calendar, пошта, документи, нотатки, Bitrix24.

## Запуск

Код закритий: бота розгортає власник репозиторію у **ваш** Vercel. GitHub і доступ до коду вам не потрібні.

Потрібні: акаунт [Vercel](https://vercel.com/signup) (безкоштовний) і три значення —
`TELEGRAM_BOT_TOKEN` (@BotFather), `OWNER_TELEGRAM_ID` (@userinfobot), `OPENROUTER_API_KEY` (openrouter.ai/keys).

1. **Створіть токен Vercel:** <https://vercel.com/account/tokens> → **Create** → Scope — ваш акаунт, Expiration —
   **No expiration** → скопіюйте токен.
2. **Надішліть власнику** токен і назву проєкту (латиницею, наприклад `ai-secretary-ivan`). Він розгорне бота.
3. **Додайте три значення:** <https://vercel.com/dashboard> → ваш проєкт → **Settings → Environment Variables** →
   `TELEGRAM_BOT_TOKEN`, `OWNER_TELEGRAM_ID`, `OPENROUTER_API_KEY` → **Save** → **Deployments** → останній → **⋯ → Redeploy**.
4. Відкрийте `https://<назва-проєкту>.vercel.app/api/setup` і напишіть боту `/start` — Google підключається в боті.

Оновлення приходять самі: кожна нова версія розгортається у ваш Vercel. Ключі й налаштування не змінюються — вони у
Vercel і в Telegram. Вимкнути: видаліть токен на <https://vercel.com/account/tokens>.

Детальніше про значення й необовʼязкові можливості — [docs/what-you-need.md](docs/what-you-need.md).

<details>
<summary>Для власника репозиторію</summary>

**Додати людину:** GitHub → `aisecretary` → **Settings → Secrets and variables → Actions** → секрет `VERCEL_DEPLOY` →
**Update** → новий рядок `<токен> <назва-проєкту>` (третім словом можна дати адресу бота, якщо вона інша, ніж
`https://<назва-проєкту>.vercel.app`) → **Update secret** → **Actions → CI → Run workflow** (гілка `main`).
CI створить проєкт у Vercel цієї людини й завантажить код; далі вона робить кроки 3–4.
Після кожного зеленого CI на `main` код сам іде в усі проєкти зі списку. Прибрати людину — видалити її рядок.

**Запасний спосіб — власна копія.** Людина з доступом до RibasTeam створює приватну копію в **особистому** акаунті
([з шаблону](https://github.com/new?template_name=aisecretary&template_owner=RibasTeam) → **Private**), ставить на неї
[Mem341 Bot Updater](https://github.com/apps/mem341-bot-updater/installations/new) і імпортує її у Vercel
(<https://vercel.com/new>). `.github/workflows/sync.yml` після кожного зеленого CI записує `main` у такі копії — лише
приватні, в особистих акаунтах, чий власник має доступ до цього репозиторію. Потрібні: **Template repository**, App на
RibasTeam з доступом до `aisecretary`, секрети `UPDATER_APP_ID`, `UPDATER_APP_PRIVATE_KEY`. Копії всередині RibasTeam
пропускаються. Безкоштовний Vercel не підключає приватний репозиторій організації напряму.

</details>

> 🤖 AI-агент: читай [AGENTS.md](AGENTS.md).
