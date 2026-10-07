import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoUpdateLink, offerAutoUpdate, UPDATE_CALLER } from "../src/bot/autoUpdate";
import { connectGoogle, lastBotMessage, mockFetch, resetInstance, testEnv } from "./helpers";

beforeEach(() => {
  resetInstance();
  vi.stubEnv("VERCEL_GIT_REPO_OWNER", "someone");
  vi.stubEnv("VERCEL_GIT_REPO_SLUG", "aisecretary");
  vi.stubEnv("VERCEL_GIT_COMMIT_REF", "main");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const github = (status: Record<string, number>) => (url: URL) =>
  url.hostname === "api.github.com" ? Response.json({}, { status: status[url.pathname] ?? 404 }) : undefined;

describe("one-click auto-update for a copy made by Vercel's button", () => {
  it("the link opens GitHub's new-file page with the small workflow that calls the source's update", () => {
    const link = new URL(autoUpdateLink()!);
    expect(link.origin + link.pathname).toBe("https://github.com/someone/aisecretary/new/main");
    expect(link.searchParams.get("filename")).toBe(".github/workflows/update.yml");
    expect(link.searchParams.get("value")).toBe(UPDATE_CALLER);
    expect(UPDATE_CALLER).toContain("uses: Mem341/aisecretary/.github/workflows/update.yml@main");
    // The source's update workflow can be called that way.
    expect(readFileSync(".github/workflows/update.yml", "utf8")).toMatch(/^\s+workflow_call:/m);
    vi.stubEnv("VERCEL_GIT_REPO_OWNER", "Mem341");
    expect(autoUpdateLink()).toBeNull();
  });

  it("a private copy (not visible) gets the button once; a copy that has the workflow gets nothing", async () => {
    await connectGoogle();
    mockFetch([github({})]);
    const { env } = testEnv();
    expect(await offerAutoUpdate(env)).toBe(true);
    expect(lastBotMessage("автооновлення").text).toContain("Commit changes");
    expect(await offerAutoUpdate(env)).toBe(false);
  });

  it("a public copy that already has the update workflow: quiet", async () => {
    await connectGoogle();
    mockFetch([github({ "/repos/someone/aisecretary/contents/.github/workflows/update.yml": 200 })]);
    const { env } = testEnv();
    expect(await offerAutoUpdate(env)).toBe(false);
  });
});
