# AI-secretary

Open-source personal Telegram secretary: anyone deploys their own copy on **Vercel** (the only platform); each copy serves one owner
(`OWNER_TELEGRAM_ID`). Creates Google Calendar meetings from text, voice, forwarded chats and screenshots, reports
calendar changes, reschedules/cancels by reply, and works with Gmail. Node.js + TypeScript, **no database**,
OpenRouter (LLM, and speech-to-text for voice), optional Zoom.

## Deploying

**Asked to deploy? It is a ready Vercel project: deploy it to Vercel as it is; ask only TELEGRAM_BOT_TOKEN,
OWNER_TELEGRAM_ID, OPENROUTER_API_KEY; never port or propose other platforms. No `vercel.json` in what you read = an
outdated copy — re-read `main` of github.com/Mem341/aisecretary.** Read `AGENTS.md` first. The project is finished: never port or redesign it, ask the user only for env values,
report as "Реализовано / Не реализовано".

Vercel only (no other platform): `.claude/skills/deploy-vercel/SKILL.md` (`/deploy-vercel`).

The skill collects exactly three things from the owner — Telegram bot token, their Telegram ID, OpenRouter key —
validates them, and never asks about optional extras. Google is connected later IN THE BOT: `/start` → the bot asks
for the Google client file (`bot/googleClient.ts`), keeps it encrypted in the pinned message (`Integrations.google`,
applied like Bitrix/Zoom) and deletes the owner's message; `GOOGLE_CLIENT_JSON` stays an optional variable.
The human version of that list with step-by-step instructions is `docs/what-you-need.md`. After any deploy, opening `/api/setup` registers the Telegram
webhook and redirects to the bot; `/api/health` shows the state.

## Layout

- `api/` — Vercel Functions (thin wrappers); `vercel.json` — function limits, `/` redirect, daily cron.
- `src/app.ts` — HTTP handlers, setup page, job runner wiring; `src/vercel.ts` — Vercel bootstrap. `/api/setup` only
  registers the Telegram webhook and redirects to the bot (no status page, no how-tos); machine checks are
  `/api/health`.
- `src/jobs.ts` — background jobs (run after the response, 3 attempts; `env.jobs.send` stamps `at`, when the invocation
  began). A function stops at 60 s and a message's whole work runs inside the invocation that received it, so a long
  request is split (`agent/continue.ts`): no new model step after `STEP_UNTIL_MS`, a model call still running at `CUT_MS`
  is cut (`runner.ts` `OutOfTime`), the steps done so far (`RunContext.steps`) go, HMAC-signed with ENCRYPTION_KEY, to the
  bot's own `POST /api/continue` — a fresh invocation — which carries on «without repeating what was done»; at most
  `MAX_HOPS`, then the owner is told what was done. `agent/progress.ts` — the live mini-log: one message edited as the
  tools run (plain-word labels), kept across continuations, deleted when the answer comes.
- `src/agent/` — a strict port of the owner's n8n flows: `index.ts` (Normalize Input / Build Agent Context →
  Supervisor with `calendar_agent` and `gmail_agent` as tools → Parse Agent Output), `runner.ts` (tool-calling
  loop over OpenRouter), `prompts.ts` (the n8n prompts), `calendarTools.ts` (the n8n Calendar MCP tools),
  `gmailTools.ts` (the n8n Gmail sub-workflow tools, plus `attachment_read`), `docsTools.ts` (the Docs Agent: Google
  Drive, Sheets, Docs via `google/workspace.ts`, scope `drive` — read, create, append, move, share; NOTHING is ever
  deleted, trashed or cleared, keep it that way; a file sent in the chat is read even without the scope; long texts come
  in 20 000-character parts (`lib/parse.ts` `textPart`, the tools' `part`), searches and folders 25 files a page
  (`nextPage`); with many matches the agent asks the owner to narrow instead of paging through everything), `peopleTools.ts` (`find_person` for the calendar and mail agents: an email by a name in any case form — calendar contacts,
  Bitrix24 users when connected, then the From/To/Cc of the owner's recent mail (headers only, cached 10 min)), `files.ts`
  (a file as text for a tool: `lib/parse.ts` reads .docx/.xlsx/.pptx/.csv/text without dependencies via `lib/unzip.ts`;
  a PDF goes to the model as a `file` part with OpenRouter's free pdf-text parser), `notesTools.ts` (the Notes Agent,
  `notesPrompt`: the owner's notes, to-dos and personal reminders — `note_add` / `note_search` / `note_update` /
  `note_archive`; stored by `google/notes.ts` in ONE sheet «Нотатки» in the folder «AI-secretary» on the owner's Drive
  (scope drive, `OwnerSettings.nt`), made on first use and announced once (again if it was deleted); every cell written
  as text; nothing is ever deleted — done or archived; a reminder is a signal `note:<id>` in the signal calendar (a
  repeating one an RRULE series; one occurrence is `<id>_<time>`), `handleReminderEmail` → `sendNoteReminder` with
  ✅ / ⏰ / 📅 buttons `nt:…` handled in code (`noteButton`); a reply to it carries `[noteId: …]`; the morning report's
  «📒» block (`notesDigest`, on Mondays the week in numbers); full signal syncs never touch `note:` signals;
  «додай нотатку» in reply to a meeting stays the meeting's description), `memory.ts` (one-session window memory), `html.ts` (the answer as
  Telegram HTML: Markdown and web tags mapped, only Telegram's tags, proper nesting, safe links, never cut —
  `Telegram.send` splits long text keeping tags whole),
  `route.ts` (the Supervisor's keyword routing table in code: an obvious calendar/mail request, or a reply to the
  bot's notice, goes straight to its agent; anything unclear goes to the Supervisor). Routing order in `runSupervisor`:
  1) a reply to the bot's own notice — code; 2) the decision model (`decide.ts`, OpenRouter's decisions API,
  `ROUTER_MODEL`, default `cloudflare/clef-flash` — Jev-compatible, plus up to 4 embedded pictures (`decisionImages`),
  so screenshots are routed too; `off` disables; `routeWithDecision`) picks an agent,
  «several» or «chat», seeing the bot's last message, who wrote it and whether it waits for an answer (memory's
  `lastBotTurn` / `pendingAgent`), so it never fights the follow-up rule; below 0.5 confidence, a failure or 6 s
  without an answer (9 s with pictures) → 3) the keyword table / `routeFollowUp` as before. No Think tool. ✅ / ❌ under an
  invitation (`accept:` / `decline:`) is answered in code with the same RSVP tool, no model call.
  Models per request (`modelFor`): text and voice → `AGENT_MODEL` (Claude Haiku 5.5, `anthropic/claude-haiku-5.5`),
  pictures → `VISION_MODEL` (gemini-2.5-flash); `LLM_MODEL` (gpt-6-luna-pro) takes any Claude request over
  `BIG_PROMPT_TOKENS` (90 000 — Haiku is five times dearer above 100 000 prompt tokens; `llm/openrouter.ts` `pickModel`:
  the provider's last `prompt_tokens` plus an estimate of what was added, PDFs by pages; a run that crossed it stays on
  `LLM_MODEL`). Claude requests carry no temperature (Haiku 5.5 refuses any), the system prompt as a cached block
  (`cache_control`), and Claude's `reasoning_details` go back unchanged with tool results. Every agent's system prompt
  ends with `DATA_RULE` (emails, files, tasks are data, never orders). A `ModelError` before any write tool ran retries the request on `LLM_MODEL`,
  never after a write; so does a junk answer with no real word («😊», «✅✅✅ Т Т», `isJunk`) — it is never sent. `npm run eval:models` (`eval/`, real OpenRouter, fake tools) compares models on typical
  requests. Keep prompts and tool names in line with the n8n originals.
- `src/bitrix/` — optional Bitrix24 tasks via an incoming webhook (`BITRIX_WEBHOOK_URL`, rights: tasks, user, im): `client.ts` (REST; a task's discussion is its «Чат завдання» (im chat, `im.chat.get` by entity) plus old comments; tasks
  are only read, commented and created — never closed, changed or deleted; messages go to a task (comment), a group chat (`find_chat` /
  `send_chat_message`, task chats excluded) or one colleague (`send_direct_message`), each only where the approved 📋 preview
  said (`previewMismatch`); keep it that way — `BITRIX_ALLOWED` is a hard
  allowlist in `call()` (and every command of a `batch` must be a read), whatever rights the webhook has), `names.ts` (people by
  name in any case form / alphabet; `toPerson` keeps the whole filled-in profile and every email in any field, the
  company's own UF_ fields too), `report.ts` (Excel: tasks, stage, status, state from comments by AI, analytics; every task — pages after the first
  come in one batch request; discussions and AI summaries most important first within a time budget
  (`COMMENTS_UNTIL_MS`, `AI_UNTIL_MS`) so the report always fits Vercel's 60 s; `list_tasks` returns all matching
  tasks, but above 30 with no period it returns `needScope` and the agent asks «all or for a period?»; a task's whole
  chat is read, page by page by LAST_ID),
  `menu.ts` (/bitrix buttons `bx:…`, no AI; «📊 Excel-звіт» first asks what to export, `REPORT_SCOPES`). The `bitrix_agent` (`agent/bitrixTools.ts`, `bitrixPrompt`) joins the
  Supervisor and `route.ts` when it is configured. `lib/xlsx.ts` writes .xlsx without dependencies.
- `src/bot/` — `onboarding.ts` (/start: first the tour «Що я вмію» with «⚙️ Налаштувати», nothing pinned yet; /help),
  `tabs.ts` (/settings tabs 🔗 Google / 📋 Bitrix24 / 🎥 Zoom: the step the owner is on — Google: 1) the client file,
  2) «Увійти в Google» — with the video and the one button that step needs), `settings.ts` (/settings: what is connected, reminder times and the
  morning list chosen with `set:…` buttons, no AI), `owner.ts` (profile from Telegram/Google/env),
  `contacts.ts` (names → emails from calendar attendees), `guides.ts` («📖 Інструкції» in /help and /settings: Google
  APIs and setup, Telegram, Bitrix24; the owner adds a video by replying to a guide with it, kept in `OwnerSettings.gv`). `notesMenu.ts` (/notes and /settings → «📒 Нотатки»: lists without AI, the sheet's link, the report's notes block, buttons `nm:…`; `ensureNotesSheet` makes the sheet right after an update — the news job — daily and on connect, so the owner is told at once). Commands: /start /settings /notes /bitrix /reset /help; everything else
  goes to the agents.
- `src/google/` — OAuth (grant in a pinned message), Calendar API + push notices (`sync.ts`: n8n invitation
  format with `accept:{id}` / `decline:{id}` buttons; push channel ids are unique per bot and day — Google requires them
  unique per Cloud project; an invitation is news when fresh or still unanswered; a recurring one once, claimed on the
  series, never on an instance), `reminders.ts` (meeting reminders), `digest.ts` (the morning report: meetings with guests/links/overlaps/free
  windows plus the blocks ticked in /settings → ☀️ — invitations with ✅/❌, mail, AI mail summary, Bitrix24, tomorrow; at
  the owner's time via a `digest:` signal in the signal calendar; `sendDigestOnce` claims the day's signal (`aisSent`) so it
  goes once; `sendDueDigest` — any wake-up up to 3 h after the time sends it if Google's signal did not; the daily cron
  (`sendMorningFallback`, its own `morning` job next to `daily`) when Google does not wake the bot, the time has passed,
  or yesterday's signal never brought the report),
  Gmail API + Pub/Sub push (`gmailPush.ts`: n8n WF3 "📧 Нова пошта!" format).
- Meeting reminders use Google as the clock — no cron, no outside service (the owner forbade both). Each chosen time
  gives BOTH a Telegram message and a Google Calendar notification (always both — the owner asked for no channel buttons):
  while they fit in Google's 5 reminders per event (1–2 marks, `fitsOnMeeting`) the meeting itself carries both an email
  signal and a popup per mark — no copy; with 3+ marks the Telegram email signals move to a shadow event in the bot's own
  calendar «AI-secretary · сигнали» (`google/signals.ts`, scope calendar.app.created), which also holds the morning
  report's daily signal.
  `applyEmailReminders` keeps both in step (connect, daily, calendar push, settings);
  Google sends the email at that minute, Gmail push wakes the bot, `handleReminderEmail` sends the Telegram reminder
  and trashes the email. The Gmail push itself is set up by the bot in the OAuth client's project (`pubsub.ts`
  `setupGoogleWake`, scope pubsub; the owner only enables the Cloud Pub/Sub API); /settings → ⏰ → «🔁 Налаштувати», shown only while
  reminders do not work (`wake.ts` `reportWake`), sets up and checks each link in plain words (no test event — the owner
  asked). /settings → «📧 Нова пошта в бот» (`OwnerSettings.ml`) switches the new-mail notices; reminder signals always work.
- `vercel.json`: the one daily cron (digest, renewing the calendar channel and the Gmail watch) — do not add more;
  /api/cron/reminders stays as a manual check of reminders.
- `src/telegram/hidden.ts` — data hidden inside the bot's own messages; `src/session.ts` — short-lived
  in-instance memory; `src/zoom/` — Zoom API.

## Where state lives (there is no database)

- Google grant: encrypted in ONE pinned message of the owner's chat (`loadGrant` reads it via getChat). The owner's
  /settings choices (`OwnerSettings`: reminder minutes, morning list) sit unencrypted, and Bitrix24 / Zoom keys the
  owner gave in /settings (`Integrations`, `bot/connect.ts`) sit encrypted, in the same message's hidden data; saving
  edits that message in place (or sends and pins it when Google is not connected yet). `integrations.ts` fills
  `env` from them at the start of every update and job, unless a deployment variable is set.
- "Which meeting/email is this reply about": hidden in the bot's own notices (`hiddenData` / `readHidden`) and
  passed to the agents as `[eventId: …]` / `[messageId: …]` in the reply context. Other hidden data likewise lives
  in the bot's own messages; Telegram returns it with button presses and replies. Keep it under
  `MAX_HIDDEN`.
- Calendar: read live; what the bot already reported is a private extended property on each event
  (`aisStart`, `aiSecretaryDraft`, `aisBotCancel`, `aisRsvp` — guests' answers already reported), written with
  If-Match on the event's etag before a notice or reminder is sent (`claimPrivate`): parallel copies of the bot
  handling the same push race there and only one sends. Gmail: a hidden label marks reported emails.
- The agents' chat memory (`agent/memory.ts`, the owner asked for it) — n8n's Window Buffer Memory (LangChain's
  buffer window memory) without a database: ONE session, ONE file, memory.json, in the bot's hidden Drive folder
  (`google/drive.ts`, scope `drive.appdata`), shared by all agents: the last 20/50/100 question–answer pairs (owner's
  choice, `OwnerSettings.m`), a new pair pushes out the oldest; plus facts the agents save with `remember_fact`. The
  latest `SEND` pairs (12 h) go to the model as real chat turns (`conversationHistory`) with the rule not to redo what
  was done (`conversationBlock`); each answer keeps the agent that gave it, so a reply to the bot's question goes back
  to that agent (`pendingAgent`, 30 min; `route.ts` `routeFollowUp` — only sure words of another topic take it elsewhere). `delete_event` refuses unless the CURRENT message asks (`deletionAllowed`);
  several / «all» only after «так». In JS regexes `\b` does not work next to Cyrillic letters. Loaded at the start of
  an agent request, written after the answer. Without the Drive scope it stays in the instance.
- Bursts of forwarded messages (`session.ts`): in memory, self-expiring; losing it may cost a duplicate, never data.
  The owner's own messages too: each gets 👀 (`setMessageReaction`) and waits `INBOX_WAIT_S` (2.5 s) in the chat's
  inbox; the latest one's `inbox` job takes the whole burst as ONE request (text, photos, files; an album, a split long
  text, «…» + «ну точніше…»), and `oneAtATime` keeps a chat's requests from overlapping — what comes meanwhile goes next,
  glued. The answer is a reply to the last message. A 📋 preview gets «✅ Так / ✏️ Змінити» (`PREVIEW_BUTTONS`, `ok:…`):
  ✅ goes to the inbox as the owner's «так» (the same `approved` check), ✏️ only asks what to change.
  Do not add a database or any other store.

## Rules

- The bot answers only `OWNER_TELEGRAM_ID`; keep every entry point behind that check.
- Keep the deployment generic (no company-specific names or data). The app boots with only `OWNER_TELEGRAM_ID`,
  `TELEGRAM_BOT_TOKEN`, `OPENROUTER_API_KEY`; Google keys are collected at deploy but the app
  must still start without them; new features must be optional or derived.
- NOTHING that changes things or reaches people runs without the owner: every meeting create/move/edit/cancel, email send/reply/trash, Bitrix24 task/comment and Drive write (`NEEDS_YES` in `agent/index.ts`) is refused in code unless the bot's previous message was a preview starting with 📋 (`PREVIEW_MARK`) and the owner's current message is a short plain «так» (`isYes` / `approved` — «так, але…», «постав зустріч з …» are not); only reading needs none, and the bot's own chat memory (`remember_fact`); a button the owner presses (✅ / ❌ under an invitation, a reminder's buttons) is itself the confirmation; ✅ under a preview or a reply to it carries the preview's text (`approved(…, repliedTo)`), so it works whatever the memory holds. A meeting needs what, when and WHO from the owner: the create tools refuse without a guest unless `withoutGuests` (the owner said so), and a «нагадай мені» is a note, never a meeting; before a meeting with people `check_free_busy` gets the guests (`attendeesJson`, `proposedStart/End`) and Google's free/busy (scope calendar.freebusy, `Calendar.othersBusy` — only when, never what) gives each guest's busy times, `conflicts` and windows `free` for all; a busy guest → the agent asks before creating, a hidden calendar is said, not guessed; sending or trashing mail
  needs the same preview and «так». Keep the bot's own Calendar writes silent: set
  `aisStart` in the same write (or `aisBotCancel` before a delete).
- Keep the Vercel `api/*` files and the docs' URLs in sync when adding an endpoint. Do not add other platforms.
- Compiles to CommonJS (`tsconfig.json`), which Vercel's Node runtime needs for extensionless imports.
- Every change the owner would notice gets a release in `src/changelog.ts` (next number, newest first, plain words):
  after the deploy the bot tells the owner once what was added/changed (`bot/news.ts`, the last seen number is
  `OwnerSettings.v`) and checks live whether the owner must do something (reconnect Google, the reminders check).
  Write release lines for every owner: what the product does now, in general words — never this owner's case, test
  data or names; `added` = new ability, `changed` = works differently, `fixed` = did not work and now does (shown as
  «Виправлено:»).
- Updates: a deployed copy is the owner's FORK of Mem341/aisecretary (public) imported into Vercel. Its
  `.github/workflows/sync.yml` (skipped in Mem341/aisecretary itself; every 30 min and on «Run workflow») adds the
  original as `upstream`, and once the original commit's `test` check passed merges `upstream/main` into the fork's
  `main` and pushes with the job's own token — no token, no secret; keep it that way. That token cannot write
  `.github/workflows`: then the rest is merged and the fork's `.github` kept, the log asks for one «Sync fork». GitHub
  keeps Actions (and schedules) off in a new fork — the owner enables them once (README). A fork's schedule is late or silent, so the
  reliable path is the owner's own GitHub token for their fork in Vercel's `GITHUB_TOKEN` (`forkSync.ts`): the bot's
  wake-ups (`checkNews`, at most once a minute per instance) and the daily cron run the `fork_sync` job — the original's
  tested main via GitHub's merge-upstream («Sync fork»); the fork is `GITHUB_REPO` or Vercel's
  `VERCEL_GIT_REPO_OWNER/SLUG`; never a token in code, never one token for everyone. Owners change nothing in code;
  every personal setting is an env variable (`.env.example`, e.g. `TIMEZONE`) or a bot setting.
  `.github/workflows/wake.yml` opens the bot's `/api/setup` the moment Vercel reports a successful production deploy
  (`deployment_status`), so «🆕 Бот оновлено» comes at once: it derives the production address from the deploy's own
  («<project>-<team>.vercel.app», «<project>.vercel.app», or the repo variable `BOT_URL`) and wakes only the one whose
  `/api/health` reports this commit.
- Deploys: `.github/workflows/ci.yml` runs typecheck
  and tests, then — with the ONE repository secret `VERCEL_DEPLOY`, a line per bot «<Vercel token> <project name> [<bot
  address>]» (the person's own Vercel token) — makes the project if it is new (`vercel project add`), uploads the code
  with the Vercel CLI (no Git connection) and opens each bot's `/api/setup` (default `https://<project>.vercel.app`) to
  wake it; the person sets the three values in their Vercel project. «Run workflow» (workflow_dispatch) on `main`
  deploys a newly added line at once. Never put a token into the code.
- Text sent to a model goes through `lib/text.ts`: `safeJson` for every request body (a half emoji — a lone surrogate — is
  invalid JSON for some providers, and one kept in memory broke every later request), `cutText` instead of `slice` when
  shortening text; tool-call arguments that are not valid JSON are echoed back as `{}`. `providerFor`: an OpenAI model is
  served by OpenAI first (OpenRouter's `provider.order`, fallbacks allowed).
- Check before pushing: `npm run typecheck && npm test` (tests mock all outbound HTTP; `test/helpers.ts` has a fake Telegram that keeps messages, entities and the pin).
