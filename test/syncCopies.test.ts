import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
// @ts-expect-error — a plain ES module run by GitHub Actions
import { appJwt, verdict } from "../.github/scripts/sync-copies.mjs";

const SOURCE = "RibasTeam/aisecretary";
const copy = (over: Record<string, unknown> = {}) => ({
  full_name: "someone/aisecretary",
  private: true,
  archived: false,
  owner: { login: "someone", type: "User", id: 1 },
  template_repository: { full_name: SOURCE },
  ...over,
});
const decide = (repo: Record<string, unknown>, ownerPermission = "read", packageName: string | null = null) =>
  verdict({ repo, ownerPermission, packageName, source: SOURCE });

describe("which copies get the closed source", () => {
  it("a private copy from the template, its owner with access → yes", () => {
    expect(decide(copy())).toEqual({ ok: true, why: "allowed" });
    expect(decide(copy({ template_repository: null }), "write", "ai-secretary").ok).toBe(true);
  });

  it("never: an owner without access, a public repository, an organisation, someone else's project, the source", () => {
    expect(decide(copy(), "none").why).toMatch(/no access/);
    expect(decide(copy(), "unknown (HTTP 403)").ok).toBe(false);
    expect(decide(copy({ private: false })).why).toMatch(/public/);
    expect(decide(copy({ owner: { login: "acme", type: "Organization" } })).why).toMatch(/personal/);
    expect(decide(copy({ template_repository: null }), "read", "other-app").why).toMatch(/not a copy/);
    expect(decide(copy({ full_name: SOURCE })).why).toMatch(/source/);
    expect(decide(copy({ archived: true })).ok).toBe(false);
  });

  it("the App's JWT is a valid RS256 token for its id", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt: string = appJwt("5218424", privateKey.export({ type: "pkcs1", format: "pem" }), 1_000_000);
    const [head, body, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(body!, "base64url").toString())).toEqual({ iat: 999_940, exp: 1_000_540, iss: "5218424" });
    expect(verify("RSA-SHA256", Buffer.from(`${head}.${body}`), publicKey, Buffer.from(sig!, "base64url"))).toBe(true);
  });
});
