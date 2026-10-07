<div align="center">

# 🗓 AI-secretary

**Особистий AI-секретар у Telegram**

Зустрічі · Пошта · Документи · Нотатки · Bitrix24 — текстом, голосом чи скріншотом

<br>

| 📅 Календар | 📧 Пошта | 📁 Документи | 📒 Нотатки | 📋 Bitrix24 |
|:---:|:---:|:---:|:---:|:---:|
| ставить, переносить,<br>скасовує зустрічі | читає, шукає,<br>відповідає | Google Диск,<br>таблиці, PDF | ідеї, справи,<br>нагадування | задачі, чати,<br>Excel-звіт |

</div>

---

## 🚀 Як розгорнути собі

> ⏱ ~10 хвилин · 💸 безкоштовно (GitHub + Vercel) · 🧑‍💻 без програмування

### 1️⃣ &nbsp;Візьміть три значення

| | Що | Де взяти |
|:---:|---|---|
| 🤖 | **Токен бота** | [@BotFather](https://t.me/BotFather) → `/newbot` → назва → імʼя на `…bot` → токен `123456:AA…` |
| 🆔 | **Ваш Telegram ID** | [@userinfobot](https://t.me/userinfobot) → `/start` → число **Id** |
| 🔑 | **Ключ OpenRouter** | [openrouter.ai/keys](https://openrouter.ai/keys) → **Create Key** → `sk-or-v1-…` · поповніть баланс на $5–10 |

### 2️⃣ &nbsp;Зробіть Fork

1. Відкрийте 👉 **[github.com/Mem341/aisecretary/fork](https://github.com/Mem341/aisecretary/fork)**
2. Нічого не змінюйте → **Create fork**

### 3️⃣ &nbsp;Створіть ключ GitHub — щоб бот оновлювався сам

1. Відкрийте 👉 **[github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)**
2. **Token name** → `aisecretary-update` · **Expiration** → найдовший строк
3. **Repository access** → **Only select repositories** → виберіть **свій** форк `<ваш-логін>/aisecretary`
4. **Permissions** → **Add permissions** → поставте:

   | Permission | Access |
   |---|---|
   | **Contents** | `Read and write` |
   | **Workflows** | `Read and write` |

5. **Generate token** → скопіюйте `github_pat_…` *(його покажуть лише раз)*

### 4️⃣ &nbsp;Розгорніть у Vercel

1. Відкрийте 👉 **[vercel.com/new](https://vercel.com/new)** → **Import** навпроти свого форка `aisecretary`
2. Розгорніть **Environment Variables** і додайте чотири змінні:

   | Name | Value |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | 🤖 токен бота |
   | `OWNER_TELEGRAM_ID` | 🆔 ваш Telegram ID |
   | `OPENROUTER_API_KEY` | 🔑 ключ OpenRouter |
   | `GITHUB_TOKEN` | 🔄 ключ GitHub з кроку 3 |

3. **Deploy** → дочекайтеся «Congratulations» 🎉

### 5️⃣ &nbsp;Запустіть бота

1. Відкрийте `https://<назва-проєкту>.vercel.app/api/setup` — відкриється ваш бот
2. Напишіть `/start` → **⚙️ Налаштувати** → підключіть Google прямо в боті (є відео)

> ✅ **Готово.** Оновлення приходять самі: бот бере нову перевірену версію, Vercel її розгортає,
> у Telegram приходить «🆕 Бот оновлено».

---

## ⚙️ Необовʼязкові змінні

Vercel → проєкт → **Settings → Environment Variables** → додати → **Redeploy**.

| Name | Що дає | За замовчуванням |
|---|---|---|
| `TIMEZONE` | ваш часовий пояс | `Europe/Kyiv` |
| `OWNER_NAME` · `OWNER_POSITION` · `OWNER_PHONE` | підпис в описі зустрічей | імʼя з Telegram |
| `DEFAULT_DURATION_MIN` | тривалість зустрічі, хв | `60` |
| `DEFAULT_FORMAT` | `offline` · `google_meet` · `zoom` | `offline` |
| `DEFAULT_ADDRESS` | адреса офлайн-зустрічей | — |

Google, Bitrix24 і Zoom підключаються в боті через `/settings`, не змінними. Повний список — [.env.example](.env.example).

---

## ⚠️ Важливо

- 🚫 **Не змінюйте код у своєму форку** — інакше оновлення зламаються. Усе своє — змінні Vercel і `/settings` у боті.
- 🔒 **Ключі нікому не надсилайте** й не вставляйте в код — вони лише у вашому Vercel.

📖 Детальніше — [docs/what-you-need.md](docs/what-you-need.md) · 🤖 AI-агент: читай [AGENTS.md](AGENTS.md)
