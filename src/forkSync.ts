import type { Env } from "./env";

/** The original every copy is a fork of. */
export const UPSTREAM = "Mem341/aisecretary";
const API = "https://api.github.com";

export type ForkSync = "updated" | "current" | "waiting" | "conflict" | "failed";

/**
 * GitHub's «Sync fork», pressed by the bot: when the owner put a GitHub token for their fork into GITHUB_TOKEN, every
 * wake-up (at most once a minute per instance, app.ts) takes the original's main into the fork once the original's
 * `test` check has passed; Vercel deploys the push and the bot then says «🆕 Бот оновлено». GitHub's own schedule in a
 * fork (sync.yml) is late or silent, this is not. Without the token nothing happens here.
 */
export async function syncFork(env: Env): Promise<ForkSync> {
  const repo = env.GITHUB_REPO;
  if (!env.GITHUB_TOKEN || !repo || repo.toLowerCase() === UPSTREAM.toLowerCase()) return "current";
  const gh = (path: string, init: RequestInit = {}) =>
    fetch(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "ai-secretary",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });

  const [upstream, fork] = await Promise.all([gh(`/repos/${UPSTREAM}/commits/main`), gh(`/repos/${repo}/compare/main...${UPSTREAM.split("/")[0]}:main`)]);
  if (!upstream.ok) throw new Error(`GitHub: the original's main — ${upstream.status}`);
  const sha = ((await upstream.json()) as { sha: string }).sha;
  // Nothing new in the original: no further calls.
  if (fork.ok && ((await fork.json()) as { ahead_by?: number }).ahead_by === 0) return "current";

  // Only a version whose tests passed in the original.
  const runs = await gh(`/repos/${UPSTREAM}/commits/${sha}/check-runs?check_name=test&per_page=100`);
  if (!runs.ok) throw new Error(`GitHub: checks of ${sha.slice(0, 7)} — ${runs.status}`);
  const checks = ((await runs.json()) as { check_runs: { status: string; conclusion: string | null }[] }).check_runs;
  if (!checks.length || !checks.every((c) => c.status === "completed" && c.conclusion === "success")) return "waiting";

  const res = await gh(`/repos/${repo}/merge-upstream`, { method: "POST", body: JSON.stringify({ branch: "main" }) });
  if (res.status === 409) return "conflict";
  if (!res.ok) throw new Error(`GitHub: Sync fork of ${repo} — ${res.status} ${(await res.text()).slice(0, 200)}`);
  const { merge_type } = (await res.json()) as { merge_type?: string };
  return merge_type === "none" ? "current" : "updated";
}

/** The fork this deployment was built from: GITHUB_REPO, or what Vercel says about its own Git source. */
export function forkRepo(val: (k: string) => string): string {
  const set = val("GITHUB_REPO").replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  if (set) return set;
  const owner = val("VERCEL_GIT_REPO_OWNER");
  const slug = val("VERCEL_GIT_REPO_SLUG");
  return owner && slug ? `${owner}/${slug}` : "";
}
