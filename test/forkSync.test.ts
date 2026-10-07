import { afterEach, describe, expect, it, vi } from "vitest";
import { forkRepo, syncFork } from "../src/forkSync";
import { mockFetch, testEnv } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const SHA = "abc1234def";
function github(opts: { ahead?: number; test?: string; merge?: number }) {
  return (url: URL, init: RequestInit) => {
    if (url.hostname !== "api.github.com") return undefined;
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer ghtok");
    if (url.pathname === "/repos/Mem341/aisecretary/commits/main") return Response.json({ sha: SHA });
    if (url.pathname.startsWith("/repos/owner/aisecretary/compare/")) return Response.json({ ahead_by: opts.ahead ?? 2 });
    if (url.pathname === `/repos/Mem341/aisecretary/commits/${SHA}/check-runs`)
      return Response.json({ check_runs: [{ status: "completed", conclusion: opts.test ?? "success" }] });
    if (url.pathname === "/repos/owner/aisecretary/merge-upstream")
      return opts.merge === 409 ? new Response("conflict", { status: 409 }) : Response.json({ merge_type: "fast-forward" });
    return new Response("not found", { status: 404 });
  };
}

describe("the bot keeps its fork updated with the owner's GitHub token", () => {
  const env = () => testEnv({ GITHUB_TOKEN: "ghtok", GITHUB_REPO: "owner/aisecretary" }).env;

  it("takes the original's tested main into the fork («Sync fork»)", async () => {
    const calls = mockFetch([github({})]);
    expect(await syncFork(env())).toBe("updated");
    const merge = calls.find((c) => c.url.endsWith("/merge-upstream"))!;
    expect(merge.method).toBe("POST");
    expect(merge.body).toEqual({ branch: "main" });
  });

  it("waits while the original's tests have not passed; nothing new — no merge; a conflict is reported", async () => {
    let calls = mockFetch([github({ test: "failure" })]);
    expect(await syncFork(env())).toBe("waiting");
    expect(calls.some((c) => c.url.endsWith("/merge-upstream"))).toBe(false);
    vi.restoreAllMocks();
    calls = mockFetch([github({ ahead: 0 })]);
    expect(await syncFork(env())).toBe("current");
    expect(calls.some((c) => c.url.includes("check-runs"))).toBe(false);
    vi.restoreAllMocks();
    mockFetch([github({ merge: 409 })]);
    expect(await syncFork(env())).toBe("conflict");
  });

  it("does nothing without a token, or in the original itself", async () => {
    const calls = mockFetch([]);
    expect(await syncFork(testEnv().env)).toBe("current");
    expect(await syncFork(testEnv({ GITHUB_TOKEN: "t", GITHUB_REPO: "Mem341/aisecretary" }).env)).toBe("current");
    expect(calls).toHaveLength(0);
  });

  it("finds the fork from GITHUB_REPO or Vercel's own Git source", () => {
    const from = (o: Record<string, string>) => forkRepo((k) => o[k] ?? "");
    expect(from({ VERCEL_GIT_REPO_OWNER: "owner", VERCEL_GIT_REPO_SLUG: "aisecretary" })).toBe("owner/aisecretary");
    expect(from({ GITHUB_REPO: "https://github.com/x/y.git", VERCEL_GIT_REPO_OWNER: "a", VERCEL_GIT_REPO_SLUG: "b" })).toBe("x/y");
    expect(from({})).toBe("");
  });
});
