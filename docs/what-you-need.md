# Що потрібно для запуску бота

Для розгортання потрібні **три речі**. Google підключається вже в самому боті.

🎥 **Відео-інструкції:** [Telegram](https://drive.google.com/file/d/1YJVHDBX5czzyU7kQ6S38jnNlzopAKCW3/view) ·
[Google](https://drive.google.com/file/d/1o1UOKdoZSm1j-d3cSjSd4-tVVB0HjeGh/view) ·
[Bitrix24](https://drive.google.com/file/d/1B2s1FbKSfogaEgv4L7fSpiqF-AbX0nq7/view) (усі — [у папці](https://drive.google.com/drive/folders/1VwJAJykWX4eBCpYlny6cfiLFqd3ESBKL)).
Ті самі відео є в боті: `/help` → 📖.

| # | Що | Приклад | Де взяти |
|---|----|---------|----------|
| 1 | **Токен Telegram-бота** | `7412345678:AAH3k…` | [§1](#1-токен-telegram-бота) |
| 2 | **Ваш Telegram ID** (число) | `123456789` | [§2](#2-ваш-telegram-id) |
| 3 | **Ключ OpenRouter** (ШІ і голосові) | `sk-or-v1-…` | [§3](#3-ключ-openrouter) |
| — | **Google** — після розгортання, у боті (`/start`) | файл `client_secret_….json` | [§4](#4-google-json-клієнта-desktop-app) |

**Бази даних не потрібно.** Доступ до Google лежить зашифрованим в **одному закріпленому повідомленні** в чаті з
ботом («🔐 Google підключено») — не відкріплюйте його. Памʼять розмови — у прихованій папці бота на вашому Google
Drive. Голосові розпізнає той самий OpenRouter.

**Необовʼязково** (без цього бот повністю працює):

| Що | Де взяти |
|----|----------|
| **Bitrix24** — задачі | [§5](#5-bitrix24-необовʼязково) |
| **Zoom** — зустрічі в Zoom | [§6](#6-zoom-необовʼязково) |
| Змінні Vercel: `OWNER_NAME`, `DEFAULT_DURATION_MIN`, `REMINDER_MINUTES`, моделі `AGENT_MODEL` / `VISION_MODEL` / `LLM_MODEL`, `PUBLIC_URL`, `CRON_SECRET` | [§7](#7-необовʼязкові-змінні-vercel) |

---

## 1. Токен Telegram-бота

1. Відкрийте [@BotFather](https://t.me/BotFather) → `/newbot`.
2. Введіть імʼя бота, потім username (має закінчуватися на `bot`).
3. BotFather надішле токен вигляду `7412345678:AAH3k…`. Це і є токен.

## 2. Ваш Telegram ID

Бот відповідатиме **лише** цьому акаунту. Усіх інших він мовчки ігнорує.

1. Напишіть будь-що [@userinfobot](https://t.me/userinfobot).
2. Він відповість числом `Id: 123456789`. Потрібне саме це число, @username не підходить.

## 3. Ключ OpenRouter

Через OpenRouter бот звертається до моделей ШІ (текст, картинки, голос).

1. Зареєструйтеся на [openrouter.ai](https://openrouter.ai).
2. Поповніть баланс: [Credits](https://openrouter.ai/settings/credits). Кількох доларів вистачить надовго.
3. [Keys](https://openrouter.ai/keys) → **Create Key** → скопіюйте ключ `sk-or-v1-…`. Він показується один раз.

## 4. Google: JSON клієнта (Desktop app)

Це дає доступ до вашого Google Calendar і Gmail. Усе робиться в [Google Cloud Console](https://console.cloud.google.com)
під тим Google-акаунтом, календар якого підключатимете. Займає близько 5 хвилин. **Redirect URI не потрібен.**

1. **Проєкт.** [Створіть проєкт](https://console.cloud.google.com/projectcreate) з будь-якою назвою, напр. `ai-secretary`.
   Далі переконайтеся, що вгорі вибрано саме його.
2. **API.** Увімкніть (**Enable**) шість бібліотек:
   - [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com);
   - [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com);
   - [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com) — ваші файли й памʼять розмови;
   - [Google Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com) — таблиці;
   - [Google Docs API](https://console.cloud.google.com/apis/library/docs.googleapis.com) — документи;
   - [Cloud Pub/Sub API](https://console.cloud.google.com/apis/library/pubsub.googleapis.com) — щоб Gmail миттєво будив
     бота: нові листи й нагадування про зустрічі (решту бот налаштує сам).
3. **Екран згоди.** Відкрийте [Google Auth Platform](https://console.cloud.google.com/auth/overview) → **Get started**:
   - App name: `AI-secretary`; User support email: ваша пошта → Next;
   - **Audience**:
     - акаунт компанії (Google Workspace) → **Internal**;
     - звичайний Gmail → **External**;
   - Contact information: ваша пошта → Next;
   - погодьтеся з умовами → **Create**.
4. **Тільки для External (звичайний Gmail).** Відкрийте [Audience](https://console.cloud.google.com/auth/audience) →
   **Publish app** → Confirm. Без цього Google відкликає доступ кожні 7 днів.
5. **Клієнт.** Відкрийте [Clients](https://console.cloud.google.com/auth/clients) → **Create client**:
   - Application type: **Desktop app**;
   - Name: `AI-secretary`;
   - **Create**.
6. У вікні, що зʼявиться, натисніть **Download JSON**. Цей файл (`client_secret_….json`) **надішліть боту в чат** —
   бот перевірить його, збереже зашифрованим і видалить з чату. (Можна й змінною Vercel `GOOGLE_CLIENT_JSON`, але не треба.)

**Як потім підключити Google у боті** (після розгортання):

1. Напишіть боту `/start` → **«⚙️ Налаштувати»** → вкладка **«🔗 Google»** і надішліть файл з кроку 6 → **«Увійти в
   Google»**.
2. Оберіть акаунт і на екрані з дозволами натисніть **«Вибрати все» (Select all)** — Google показує кожен дозвіл
   окремою галочкою, і без них не працюватимуть нагадування й памʼять. Якщо Google напише «застосунок не перевірено» —
   **Додатково → Перейти**: це ваш власний бот.
3. Браузер відкриє адресу `http://127.0.0.1…` і покаже помилку «не вдається отримати доступ» — **так і має бути**.
4. Скопіюйте цю адресу з адресного рядка й надішліть боту. Він відповість «✅ Google підключено».

**«Доступ заблоковано… застосунок тестується» (помилка 403 access_denied)** — екран згоди проєкту в режимі Testing,
а ваш акаунт не в списку тестувальників. Тип клієнта (Desktop app) тут ні до чого. Виправлення:
[Audience](https://console.cloud.google.com/auth/audience) → **Publish app** (або додайте свою пошту в **Test users**).
Назва, яку показує Google (напр. «n8n»), — це назва проєкту в **Branding**; її можна змінити на `AI-secretary`.

## 5. Bitrix24 (необовʼязково)

Підключається прямо в боті: `/settings` → **«🔗 Підключити Bitrix24»**. Бот попросить адресу вебхука:

1. У Bitrix24: **Розробникам → Інше → Вхідний вебхук**.
2. Права: **Задачі**, **Користувачі**, **Чат і повідомлення** → **Зберегти**.
3. Скопіюйте «Вебхук для виклику REST API» (`https://ваш-портал.bitrix24.ua/rest/1/abc123…/`) і надішліть боту.
   Бот перевірить його, збереже зашифрованим і видалить ваше повідомлення.

## 6. Zoom (необовʼязково)

`/settings` → **«🔗 Підключити Zoom»**:

1. [Zoom Marketplace](https://marketplace.zoom.us/develop/create) → **Develop → Build App → Server-to-Server OAuth**.
2. Scopes: **meeting:write:admin** → **Activate**.
3. З вкладки App Credentials надішліть боту трьома рядками: **Account ID**, **Client ID**, **Client Secret**.

## 7. Необовʼязкові змінні Vercel

| Змінна | Навіщо |
|---|---|
| `OWNER_NAME` | ваше імʼя для агентів (інакше — з Telegram) |
| `DEFAULT_DURATION_MIN` | тривалість зустрічі за замовчуванням (60) |
| `REMINDER_MINUTES` | нагадування до першого вибору в `/settings` → ⏰ (`30,10`) |
| `AGENT_MODEL` | текстові запити; типова — `openai/gpt-6-luna-pro` |
| `VISION_MODEL` | запити з картинками; типова — `google/gemini-2.5-flash` |
| `LLM_MODEL` | голосові й повторна спроба; типова — `openai/gpt-6-luna-pro` |
| `BITRIX_WEBHOOK_URL`, `ZOOM_ACCOUNT_ID` / `ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET` | те саме, що §5–6, але змінною |
| `GMAIL_PUBSUB_TOPIC` | власний топік Pub/Sub замість створеного ботом |
| `ENCRYPTION_KEY` | власний ключ шифрування (інакше — з токена бота) |
| `CRON_SECRET` | закрити щоденний cron від сторонніх |
| `PUBLIC_URL` | власний домен замість `*.vercel.app` |

## Якщо щось не працює

| Що бачите | Що зробити |
|---|---|
| Бот не бачить оновлень з GitHub | Один секрет `VERCEL_DEPLOY` у GitHub — [див. нижче](#автодеплой-кожне-оновлення-виходить-саме) |
| Не приходять нагадування | `/settings` → ⏰ → **«🔁 Налаштувати»** — бот скаже, чого бракує |
| «Не поставлено галочки» / немає памʼяті | перепідключіть Google й натисніть **«Вибрати все»** |
| «Cloud Pub/Sub API вимкнено» | [увімкніть Cloud Pub/Sub API](https://console.cloud.google.com/apis/library/pubsub.googleapis.com) у проєкті Google-клієнта |
| «403 access_denied … тестується» | [Audience](https://console.cloud.google.com/auth/audience) → **Publish app** |

## Оновлення: бот оновлюється сам

Якщо бота розгорнуто кнопкою **Deploy** (або агентом) — у вашому GitHub є його копія, підключена до Vercel. У ній
працює `.github/workflows/update.yml`: щогодини вона бере нову версію з github.com/Mem341/AI-secretary (лише коли її
перевірки пройшли), Vercel сам її збирає, а бот пише «🆕 Бот оновлено». Ні токенів, ні секретів, нічого у Vercel.
Оновити одразу: GitHub → ваша копія → **Actions → Update from Mem341/AI-secretary → Run workflow**.

Кілька ботів з одного репозиторію без GitHub-копій: секрет `VERCEL_DEPLOY` у цьому репозиторії, рядок на кожного бота —
`токен-Vercel назва-проєкту адреса-бота`; після кожного оновлення CI завантажує код у кожен проєкт і будить бота.
