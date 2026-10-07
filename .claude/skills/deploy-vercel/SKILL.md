---
name: deploy-vercel
description: Deploy a personal copy of the open-source AI-secretary Telegram bot to the user's own Vercel account. Ask only for three things (Telegram bot token, their Telegram ID, OpenRouter key), validate them, set env vars, deploy, finish on /api/setup, report «Реализовано / Не реализовано». Google is connected later inside the bot. No database. Use when the user asks to deploy, redeploy, set up or configure the bot on Vercel.
---

# Deploy AI-secretary to Vercel

Each copy answers exactly **one** Telegram user, the person deploying it (`OWNER_TELEGRAM_ID`).
Your job: take the user from nothing to a working bot. Ask only for what they alone can provide; do everything
else yourself.

## Rules of conduct

- **`AGENTS.md` in the repo root is binding.** The project is finished and runs on Vercel as it is. Never port it
  or propose services, databases or frameworks. Never ask technical questions or for plan approval.
- **The current code has `vercel.json` at its root.** A copy without it (or with only a few commits) is an old
  snapshot: read `main` of github.com/RibasTeam/aisecretary again; never describe or port the old one.
- **First ask for the three values of Step 1 in one message, then deploy.** Google is not needed for the deploy: the
  owner connects it later in the bot (it asks for the Google client file itself).
- **Talk in the user's language.**
- **Ask only for the three items of Step 1, in one message.** Do not ask about:
  - Zoom, Gmail push, the model, a domain, `CRON_SECRET` / `ENCRYPTION_KEY`, profile or default variables;
  - a database (there is none);
  - Google, its JSON file or a redirect URI (the bot handles Google itself).

  Set optional variables only if the user gives them on their own.
- **If the user lacks an item,** send the steps for that item only, from `docs/what-you-need.md` §1–§3. Keep the
  links.
- **Secrets:**
  - never repeat them back;
  - never write them into repository files or commit them;
  - keep them in shell variables only.
- **Tools:** prefer the Vercel MCP tools; otherwise use the Vercel CLI (`npx vercel`).

## No terminal? One link, nothing else

In a chat without a terminal, or when your sandbox cannot reach api.telegram.org / github.com: do not clone, do not
ask for network or «Capabilities» settings, a Vercel token or GitHub, do not create an empty project. Give the user
these steps (the source is private, so Vercel's clone button does not work with it — never give it) and stop:
«1) <https://vercel.com/account/tokens> → Create (без срока) → отправить владельцу RibasTeam/aisecretary токен и название проекта; 2) владелец добавляет строку в секрет `VERCEL_DEPLOY` и запускает CI; 3) Vercel → проект → Settings → Environment Variables → 3 значения → Redeploy; 4) открыть https://<проект>.vercel.app/api/setup» (с доступом к RibasTeam можно и так: «1) принять приглашение в RibasTeam; 2) <https://github.com/new?template_name=aisecretary&template_owner=RibasTeam> → ваш аккаунт → **Private** → Create repository; 3) <https://github.com/apps/mem341-bot-updater/installations/new> → только эта копия → Install; 4) <https://vercel.com/new> → Import эту копию → 3 значения → Deploy; 5) открыть https://<проект>.vercel.app/api/setup»).

## Step 1 — collect the inputs

Send this, adapted to the user's language, and wait for the answers:

> Для запуску бота потрібні 3 речі:
>
> 1. **Токен Telegram-бота** — @BotFather → `/newbot` → токен вигляду `7412345678:AAH…`
> 2. **Ваш Telegram ID** — число від @userinfobot (бот відповідатиме лише вам)
> 3. **Ключ OpenRouter** — https://openrouter.ai/keys, вигляду `sk-or-v1-…` (на рахунку мають бути кошти)
>
> Google (календар і пошту) підключите потім у самому боті — він підкаже кожен крок.

## Step 2 — validate (never print the values)

| Item | Check |
|------|-------|
| a. Bot token | Must match `^\d{6,}:[A-Za-z0-9_-]{30,}$`. Then `curl -s https://api.telegram.org/bot$TOKEN/getMe` must return `"ok":true`; remember the bot's @username. |
| b. Telegram ID | Digits only. It must not be the bot's own ID (the part of the token before `:`). |
| c. OpenRouter key | Starts with `sk-or-`. `curl -s -H "Authorization: Bearer $KEY" https://openrouter.ai/api/v1/key` must return HTTP 200. |

If a check fails: say which item is wrong and why, and ask for that item only.

## Step 3 — project, variables, deploy

1. **Project — the user's own PRIVATE GitHub copy, connected to Vercel.** That is what makes the bot update itself:
   the source github.com/RibasTeam/aisecretary is private (the user must accept the invitation to RibasTeam), and after
   every green CI it writes the new `main` into each copy where the GitHub App «Mem341 Bot Updater» is installed;
   Vercel builds every push. No token or secret for the user.
   - Simplest: «1) <https://vercel.com/account/tokens> → Create (без срока) → отправить владельцу RibasTeam/aisecretary токен и название проекта; 2) владелец добавляет строку в секрет `VERCEL_DEPLOY` и запускает CI; 3) Vercel → проект → Settings → Environment Variables → 3 значения → Redeploy; 4) открыть https://<проект>.vercel.app/api/setup» (с доступом к RibasTeam можно и так: «1) принять приглашение в RibasTeam; 2) <https://github.com/new?template_name=aisecretary&template_owner=RibasTeam> → ваш аккаунт → **Private** → Create repository; 3) <https://github.com/apps/mem341-bot-updater/installations/new> → только эта копия → Install; 4) <https://vercel.com/new> → Import эту копию → 3 значения → Deploy; 5) открыть https://<проект>.vercel.app/api/setup») (Vercel preset **Other**, no build command, root `/`). Not a fork and not Vercel's clone
     button (it works only with public code).
   - With `gh`/GitHub access: create the PRIVATE copy in the user's account from the template, install the App on it, then
     import it in Vercel (`npx vercel link` + `npx vercel git connect`).
   - No GitHub possible (`repo_no_access`, no account)? Do not ask. Deploy from files — the bot works but does not
     update itself; put that in the report: `npx vercel link --yes --project ai-secretary`, the variables,
     `npx vercel deploy --prod --yes`. Ask for a Vercel token only if the CLI is not logged in.
2. **Production variables:**
   - `TELEGRAM_BOT_TOKEN`
   - `OWNER_TELEGRAM_ID`
   - `OPENROUTER_API_KEY`

   `printf '%s' "$VALUE" | npx vercel env add NAME production` for each. Nothing else is needed.
3. **Deploy to production.**
4. **Open `https://<domain>/api/setup`.** It registers the Telegram webhook and redirects to `t.me/<bot>`
   (a "Бот не відповідає" page means the bot token is wrong).
   - If the page is a Vercel login screen, turn off Deployment Protection for production (Settings →
     Deployment Protection).
5. **`curl https://<domain>/api/health`** → `"ok": true` and `"telegram_webhook": true`.

## Step 4 — the owner connects Google in the bot (their action, tell them exactly this)

1. Write `/start` to @<bot>: it shows what it can do → «⚙️ Налаштувати» → tab «🔗 Google». The tab shows what to do in
   Google Cloud (a project, the APIs, a **Desktop app** client, with a video) and asks for the downloaded file
   `client_secret_….json` — send the file to the bot.
2. Press «Підключити Google», choose the account and on the permissions screen press «Вибрати все».
3. Google says "app isn't verified" → «Додатково» → «Перейти»: it is their own bot.
4. The browser opens `http://127.0.0.1…` with an error page. That is expected: copy that address and send it to the bot.
5. The bot answers «✅ Google підключено» and pins a «🔐 Google підключено» message. That message must stay pinned.

## Step 5 — final report

Report only in the `AGENTS.md` §4 format:
- «Реализовано»: ✅ lines;
- «Не реализовано»: ❌ what — the one action the user must take.

Include the bot's @username and the site URL. No explanations of internals, no alternatives, no questions.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Bot: «Це не файл Google-клієнта» | The owner sent another file (e.g. a service account). It must be the OAuth client JSON: Clients → Download JSON. |
| Google: «Доступ заблокирован… приложение тестируется», 403 `access_denied` | The consent screen of that Google Cloud project is in **Testing** and the account is not a test user. The client type (Desktop/Web) does not matter. Fix: Google Auth Platform → Audience → **Publish app** (or add the account under Test users). The app name shown there comes from Branding. |
| Bot: «Google не прийняв цей код» | The code is single-use and lives a few minutes. Press «Підключити Google» again. |
| «Доступ до Google втрачено» | Access was revoked, the consent screen is in Testing (7-day expiry), or the bot token / `ENCRYPTION_KEY` changed. Reconnect via `/settings`. |
| Bot silent | /api/setup must redirect to the bot and /api/health show `"telegram_webhook": true`. Check that `OWNER_TELEGRAM_ID` is the user's number, not the bot's. |
| LLM errors in the bot | OpenRouter balance is empty, or `LLM_MODEL` / `AGENT_MODEL` / `VISION_MODEL` holds a wrong model id (the agents need a model with tool calling). |
| Anything else | Vercel runtime logs. The bot also reports errors to its owner in the chat. |
