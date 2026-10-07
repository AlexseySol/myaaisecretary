// Brings the current main of the closed source repository into every copy whose owner was given access.
//
// The source is private, so a copy cannot fetch it: the source pushes instead. Each invited user makes a private copy
// (from the template) and installs the GitHub App «Mem341 Bot Updater» on that one repository. This script runs in the
// source's Actions with the App's id and key (secrets UPDATER_APP_ID, UPDATER_APP_PRIVATE_KEY), goes through every
// installation of the App and writes the source's files into each allowed repository as a new commit on its main —
// Vercel, connected to that copy, deploys it. The owner's settings live in Vercel and in the Telegram chat, not in the
// repository, so they stay as they are.
//
// The App is public — anyone may install it — so the code goes ONLY where all of this holds:
//   - the repository belongs to a personal account (not an organisation) and is PRIVATE (the code is never published);
//   - its owner has access to the source repository right now (GitHub's own permission check; a removed member stops
//     getting updates at once);
//   - it is a copy of the bot (made from the template, or its package.json is this project's).
// Never a force push: the new commit sits on top of the copy's own history.

import { createSign } from "node:crypto";
import { execFileSync } from "node:child_process";

export const SOURCE = process.env.SOURCE_REPO || "RibasTeam/aisecretary";
const API = "https://api.github.com";
const PACKAGE_NAME = "ai-secretary";
const ACCESS = new Set(["read", "triage", "write", "maintain", "admin"]);

const lower = (s) => String(s ?? "").toLowerCase();

/** May this repository receive the source? A pure decision, so it is tested without GitHub. */
export function verdict({ repo, ownerPermission, packageName, source = SOURCE }) {
  if (!repo) return { ok: false, why: "no repository" };
  if (lower(repo.full_name) === lower(source)) return { ok: false, why: "the source itself" };
  if (repo.owner?.type !== "User") return { ok: false, why: "not a personal account" };
  if (!repo.private) return { ok: false, why: "public repository — the code must stay closed" };
  if (repo.archived) return { ok: false, why: "archived" };
  if (!ACCESS.has(ownerPermission)) return { ok: false, why: `the owner has no access to ${source}` };
  const fromTemplate = lower(repo.template_repository?.full_name) === lower(source);
  if (!fromTemplate && packageName !== PACKAGE_NAME) return { ok: false, why: "not a copy of the bot" };
  return { ok: true, why: "allowed" };
}

/** The App's own token (a JWT signed with its private key, valid 9 minutes). */
export function appJwt(appId, pem, now = Math.floor(Date.now() / 1000)) {
  const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
  const body = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(pem).toString("base64url")}`;
}

async function gh(path, token, init = {}) {
  const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
    ...init,
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "ai-secretary-sync", ...init.headers },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, body };
}

async function all(path, token, key) {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const { ok, status, body } = await gh(`${path}${sep}per_page=100&page=${page}`, token);
    if (!ok) throw new Error(`${path}: HTTP ${status}`);
    const items = key ? body[key] : body;
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

const mask = (secret) => secret && console.log(`::add-mask::${secret}`);
const git = (args, env = {}) => execFileSync("git", args, { encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }).trim();

async function main() {
  const appId = process.env.UPDATER_APP_ID;
  const key = process.env.UPDATER_APP_PRIVATE_KEY;
  if (!appId || !key) throw new Error("UPDATER_APP_ID / UPDATER_APP_PRIVATE_KEY are not set in this repository's Actions secrets");
  const sha = git(["rev-parse", "HEAD"]);

  // Only the newest tested main goes out: an older run finishing late must not roll copies back.
  const head = git(["ls-remote", "origin", "refs/heads/main"]).split(/\s+/)[0];
  if (head && head !== sha) return console.log(`main is ${head.slice(0, 7)} now, this run has ${sha.slice(0, 7)} — the newer run updates the copies`);
  if (process.env.GITHUB_EVENT_NAME !== "workflow_run") {
    const checks = await gh(`/repos/${SOURCE}/commits/${sha}/check-runs?check_name=test`, process.env.GITHUB_TOKEN);
    const runs = checks.body?.check_runs ?? [];
    if (!runs.length || !runs.every((r) => r.status === "completed" && r.conclusion === "success")) {
      return console.log(`the tests of ${sha.slice(0, 7)} have not passed — nothing is sent`);
    }
  }

  const jwt = appJwt(appId, key);
  const app = await gh("/app", jwt);
  if (!app.ok) throw new Error(`the App's key was not accepted: HTTP ${app.status}`);
  const slug = app.body.slug;
  const bot = await gh(`/users/${encodeURIComponent(`${slug}[bot]`)}`, jwt);
  const committer = { name: `${slug}[bot]`, email: `${bot.body?.id ?? 0}+${slug}[bot]@users.noreply.github.com` };

  const installations = await all("/app/installations", jwt);
  const tokenFor = async (id) => {
    const t = await gh(`/app/installations/${id}/access_tokens`, jwt, { method: "POST" });
    if (!t.ok) throw new Error(`installation ${id}: no token (HTTP ${t.status})`);
    mask(t.body.token);
    return t.body.token;
  };

  // Who has access to the source: asked with the App's installation on the source's owner (Metadata: read), else with
  // this workflow's own token. Any other answer than a real permission means «no access» — never a guess.
  const sourceOwner = lower(SOURCE.split("/")[0]);
  const home = installations.find((i) => lower(i.account?.login) === sourceOwner);
  const accessToken = home ? await tokenFor(home.id) : process.env.GITHUB_TOKEN;
  if (!home) console.log(`::warning::The App is not installed on ${SOURCE.split("/")[0]} — access is checked with the workflow's token`);
  const permissionCache = new Map();
  const permissionOf = async (login) => {
    if (!permissionCache.has(login)) {
      const r = await gh(`/repos/${SOURCE}/collaborators/${encodeURIComponent(login)}/permission`, accessToken);
      permissionCache.set(login, r.ok ? r.body.permission : r.status === 404 ? "none" : `unknown (HTTP ${r.status})`);
    }
    return permissionCache.get(login);
  };

  let sent = 0;
  for (const inst of installations) {
    if (inst.id === home?.id) continue;
    const login = inst.account?.login ?? "?";
    if (inst.account?.type !== "User") {
      console.log(`${login}: skipped — not a personal account`);
      continue;
    }
    let token;
    try {
      token = await tokenFor(inst.id);
    } catch (err) {
      console.log(`${login}: ${err.message}`);
      continue;
    }
    const repos = await all("/installation/repositories", token, "repositories").catch((err) => (console.log(`${login}: ${err.message}`), []));
    for (const listed of repos) {
      const full = listed.full_name;
      const repo = (await gh(`/repos/${full}`, token)).body ?? listed;
      let packageName = null;
      if (lower(repo.template_repository?.full_name) !== lower(SOURCE)) {
        const pkg = await gh(`/repos/${full}/contents/package.json`, token);
        try {
          packageName = pkg.ok ? JSON.parse(Buffer.from(pkg.body.content, "base64").toString("utf8")).name : null;
        } catch {
          packageName = null;
        }
      }
      const v = verdict({ repo, ownerPermission: await permissionOf(repo.owner?.login ?? login), packageName });
      if (!v.ok) {
        console.log(`${full}: skipped — ${v.why}`);
        continue;
      }
      try {
        const branch = repo.default_branch || "main";
        const url = `https://x-access-token:${token}@github.com/${full}.git`;
        git(["fetch", "--quiet", "--depth=1", url, branch]);
        const theirs = git(["rev-parse", "FETCH_HEAD"]);
        const tree = git(["rev-parse", "HEAD^{tree}"]);
        if (git(["rev-parse", `${theirs}^{tree}`]) === tree) {
          console.log(`${full}: up to date`);
          continue;
        }
        // Authored as the copy's owner (Vercel deploys a private repository's commits by its owner), made by the App.
        const author = { name: repo.owner.login, email: `${repo.owner.id}+${repo.owner.login}@users.noreply.github.com` };
        const commit = git(["commit-tree", tree, "-p", theirs, "-m", `Update from ${SOURCE} ${sha.slice(0, 7)}`], {
          GIT_AUTHOR_NAME: author.name,
          GIT_AUTHOR_EMAIL: author.email,
          GIT_COMMITTER_NAME: committer.name,
          GIT_COMMITTER_EMAIL: committer.email,
        });
        git(["push", "--quiet", url, `${commit}:refs/heads/${branch}`]);
        sent++;
        console.log(`${full}: updated to ${sha.slice(0, 7)}`);
      } catch (err) {
        console.log(`::warning::${full}: not updated — ${String(err.stderr || err.message).replaceAll(token, "***").trim()}`);
      }
    }
  }
  console.log(`Done: ${sent} cop${sent === 1 ? "y" : "ies"} updated.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
