# AGENTS.md — rules for ANY AI agent that deploys or sets up this bot

Read this first. These rules override your own judgement about what to ask or propose.

**In short:** a ready Vercel project → deploy it to Vercel as it is → ask only `TELEGRAM_BOT_TOKEN`,
`OWNER_TELEGRAM_ID`, `OPENROUTER_API_KEY` → set them, deploy, open `/api/setup` → report «Реализовано / Не реализовано».
Never port, never propose other platforms or services. No `vercel.json` in your copy = an outdated copy: re-read
`main` of https://github.com/Mem341/aisecretary.

## 1. The project is finished — do not port, redesign or choose anything

- The code in `main` of <https://github.com/Mem341/aisecretary> is ready for **Vercel** as it is. Vercel is the
  only platform. Do not move it anywhere else.
- It has **no database, no queue, no file storage**. Do not propose or add any database, queue, storage, other
  hosting, service or framework.
- **Check that you read the current code.** The current `main` has `vercel.json`, `api/` and `src/` at its root and
  about a hundred commits. A copy without `vercel.json`, or with only a few commits, is an **old snapshot** (for
  example a repository attached to a chat or project long ago): do not describe it, do not port it — read `main` of
  <https://github.com/Mem341/aisecretary> again. If you cannot refresh it, tell the user in one line: «Обновите
  подключённый репозиторий (Sync) или пришлите ссылку github.com/Mem341/aisecretary заново».

## 2. Ask the user ONLY for these values — in one message

| Variable | What it is | How the user gets it |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | bot token | @BotFather → `/newbot` |
| `OWNER_TELEGRAM_ID` | their numeric Telegram ID (the only person the bot answers) | @userinfobot |
| `OPENROUTER_API_KEY` | AI key | <https://openrouter.ai/keys> |

That is all. **Google is not part of the deploy:** after it the owner writes `/start` to the bot, and the bot asks for
the Google client file itself and connects Google. Never ask for a Google JSON, client ID or redirect URI.

Step-by-step instructions for each value, to send when the user does not have it: `docs/what-you-need.md`.

**Never ask:**
- technical questions: architecture, platforms, services, "do we use X or Y?", "shall I port?";
- for approval of a plan;
- about a database, queues, storage, cron, frameworks;
- about optional extras: Zoom, Gmail Pub/Sub, Bitrix24 (`BITRIX_WEBHOOK_URL`), `OWNER_*` / `DEFAULT_*` / `LLM_MODEL` / `AGENT_MODEL` / `VISION_MODEL` / `REMINDER_MINUTES`. Set them only if the user
  gives them on their own.

## 3. Do everything else yourself

Order: **first ask for the three values (section 2) in one message, then deploy.** Nothing else to ask.

- **You are in a chat without a terminal** (claude.ai, ChatGPT, a sandbox whose network blocks api.telegram.org or
  github.com)? Then you do NOT deploy the code yourself. Never ask the user to change network, «Capabilities»,
  egress or proxy settings, never ask for a Vercel token, never clone into your sandbox, never create an empty Vercel
  project. Send the user ONE message with the three values' instructions and this link, and stop — Vercel takes the
  code from GitHub itself and asks the same three values:
  <https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FMem341%2Faisecretary&env=OWNER_TELEGRAM_ID%2CTELEGRAM_BOT_TOKEN%2COPENROUTER_API_KEY&project-name=aisecretary&repository-name=aisecretary>
  «Откройте ссылку → войдите в Vercel → вставьте 3 значения → Deploy. Потом откройте https://<проект>.vercel.app/api/setup.»
- **Deploy it as the user's own GitHub copy connected to Vercel** — that is how the bot updates itself: the copy
  carries `.github/workflows/update.yml`, which every 5 minutes takes the new version of `main` of
  github.com/Mem341/aisecretary (once its checks pass), and Vercel rebuilds every push. No token, no secret, nothing
  to set up on Vercel. The simplest way is this link: Vercel itself creates the copy in the user's GitHub, connects it
  and asks for the same three values. Give it to the user (or open it with your tools) and say «вставьте 3 значения в
  поля и нажмите Deploy, потом откройте https://<проект>.vercel.app/api/setup»:
  <https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FMem341%2Faisecretary&env=OWNER_TELEGRAM_ID%2CTELEGRAM_BOT_TOKEN%2COPENROUTER_API_KEY&project-name=aisecretary&repository-name=aisecretary>
- With a terminal (Claude Code): follow `.claude/skills/deploy-vercel/SKILL.md` — the same result: a GitHub copy
  imported into Vercel.
- **Only if no GitHub copy is possible** (the user has no GitHub, Vercel cannot reach GitHub): deploy from files — the
  bot works, but does not update itself; say so in the report. Do not ask and do not port:
  ```bash
  git clone https://github.com/Mem341/aisecretary && cd aisecretary
  npx vercel link --yes --project ai-secretary
  printf '%s' "$VALUE" | npx vercel env add NAME production   # for each variable from section 2
  npx vercel deploy --prod --yes
  ```
  The CLI needs a Vercel login or `VERCEL_TOKEN`. If you have neither, that is the one thing to ask for:
  "нужен Vercel-токен: vercel.com/account/tokens".
- After the deploy, open `https://<domain>/api/setup`: it registers the Telegram webhook by itself and redirects to the bot.

## 4. Report to the user — only in this format

Talk in the user's language. No explanations of internals, no tables of alternatives, no questions except
"send me the missing values".

```
Реализовано:
✅ Проект на Vercel создан
✅ Переменные заданы: TELEGRAM_BOT_TOKEN, OWNER_TELEGRAM_ID, OPENROUTER_API_KEY
✅ Задеплоено: https://<domain>
✅ Вебхук Telegram зарегистрирован
✅ Автообновление: копия в GitHub, бот обновляется сам каждый час

Не реализовано:
❌ Google не подключён — напишите боту /start → «⚙️ Налаштувати» → «🔗 Google»: там шаги с видео,
   бот примет файл Google-клиента и даст кнопку «Увійти в Google»
```

A line goes into "Не реализовано" only as `❌ <what> — <one action the user must take>`.
