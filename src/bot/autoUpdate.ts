import type { Env } from "../env";
import { hasGoogleAuth, loadOwnerSettings, saveOwnerSettings } from "../google/oauth";
import { Telegram } from "../telegram/api";

/**
 * Vercel's «Deploy» button copies the project into the owner's GitHub without the `.github` folder (its GitHub app may
 * not write workflows), so such a copy has nothing that brings it new versions. One click fixes it: GitHub's «new file»
 * page, opened from the bot's button with this small workflow already filled in — the owner presses «Commit changes».
 * The file only calls the source's own update workflow (a reusable workflow of a public repository), so every copy
 * always runs the current update logic. No token, no secret.
 */
const SOURCE = "Mem341/aisecretary";

/** Every 30 minutes: a copy made by the button is private, and GitHub gives a private repository 2000 free minutes. */
export const UPDATE_CALLER = `name: Update from ${SOURCE}
on:
  schedule:
    - cron: "*/30 * * * *"
  workflow_dispatch:
permissions:
  contents: write
jobs:
  update:
    uses: ${SOURCE}/.github/workflows/update.yml@main
`;

/** The GitHub page that adds the update workflow to the copy this bot runs from; null when it is not a Git copy. */
export function autoUpdateLink(): string | null {
  const owner = process.env.VERCEL_GIT_REPO_OWNER;
  const slug = process.env.VERCEL_GIT_REPO_SLUG;
  if (!owner || !slug || `${owner}/${slug}`.toLowerCase() === SOURCE.toLowerCase()) return null;
  const branch = process.env.VERCEL_GIT_COMMIT_REF || "main";
  const q = new URLSearchParams({ filename: ".github/workflows/update.yml", value: UPDATE_CALLER });
  return `https://github.com/${owner}/${slug}/new/${encodeURIComponent(branch)}?${q}`;
}

/** Whether the copy already updates itself: a public fork or copy with the workflow. A private copy is not visible — unknown. */
async function hasUpdater(owner: string, slug: string): Promise<boolean | null> {
  const get = (path: string) =>
    fetch(`https://api.github.com/repos/${owner}/${slug}${path}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "ai-secretary" },
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
  const file = await get("/contents/.github/workflows/update.yml");
  if (file?.ok) return true;
  if (file?.status !== 404) return null;
  const repo = await get("");
  // The repository itself is not found: private (the button's default) — the file cannot be seen from here.
  return repo?.status === 404 ? null : repo?.ok ? false : null;
}

/** Once: the owner of a copy without the update workflow gets the one-click button. */
export async function offerAutoUpdate(env: Env): Promise<boolean> {
  const link = autoUpdateLink();
  if (!link || !(await hasGoogleAuth(env).catch(() => false))) return false;
  const settings = await loadOwnerSettings(env).catch(() => null);
  if (!settings || settings.au) return false;
  const has = await hasUpdater(process.env.VERCEL_GIT_REPO_OWNER!, process.env.VERCEL_GIT_REPO_SLUG!);
  if (has !== true) {
    await new Telegram(env).send(
      env.OWNER_TELEGRAM_ID,
      "🔄 <b>Увімкніть автооновлення — один клік</b>\n\n" +
        "Натисніть кнопку нижче → на GitHub зелена кнопка <b>Commit changes</b> (двічі, якщо спитає). " +
        "Після цього бот сам братиме нові версії, а я писатиму, що нового.\n\n" +
        "<i>Якщо GitHub скаже, що такий файл уже є, — автооновлення вже працює, нічого робити не треба.</i>",
      { keyboard: [[{ text: "🔄 Увімкнути автооновлення", url: link }]] },
    );
  }
  await saveOwnerSettings(env, { ...settings, au: true });
  return has !== true;
}
