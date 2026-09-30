import type { Config, Env } from "./env";
import { loadIntegrations } from "./google/oauth";

/**
 * Bitrix24 and Zoom can be connected two ways: deployment variables, or keys the owner gives in /settings (kept
 * encrypted in the pinned message). This fills the env from /settings when a variable is not set, at the start of
 * every update and job, so the rest of the code just reads env.
 */

type Keys = Pick<
  Config,
  | "BITRIX_WEBHOOK_URL"
  | "ZOOM_ACCOUNT_ID"
  | "ZOOM_CLIENT_ID"
  | "ZOOM_CLIENT_SECRET"
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
  | "GOOGLE_OAUTH_MODE"
  | "GOOGLE_PROJECT_ID"
>;
const fromVariables = new WeakMap<Env, Keys>();

function variables(env: Env): Keys {
  let v = fromVariables.get(env);
  if (!v) {
    v = {
      BITRIX_WEBHOOK_URL: env.BITRIX_WEBHOOK_URL,
      ZOOM_ACCOUNT_ID: env.ZOOM_ACCOUNT_ID,
      ZOOM_CLIENT_ID: env.ZOOM_CLIENT_ID,
      ZOOM_CLIENT_SECRET: env.ZOOM_CLIENT_SECRET,
      GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
      GOOGLE_OAUTH_MODE: env.GOOGLE_OAUTH_MODE,
      GOOGLE_PROJECT_ID: env.GOOGLE_PROJECT_ID,
    };
    fromVariables.set(env, v);
  }
  return v;
}

/** Where each integration comes from: a deployment variable, /settings, or nowhere. */
export function integrationSource(env: Env, what: "bitrix" | "zoom" | "google"): "variable" | "settings" | null {
  const v = variables(env);
  if (what === "google") return v.GOOGLE_CLIENT_ID ? "variable" : env.GOOGLE_CLIENT_ID ? "settings" : null;
  if (what === "bitrix") return v.BITRIX_WEBHOOK_URL ? "variable" : env.BITRIX_WEBHOOK_URL ? "settings" : null;
  return v.ZOOM_ACCOUNT_ID ? "variable" : env.ZOOM_ACCOUNT_ID ? "settings" : null;
}

export async function applyIntegrations(env: Env): Promise<void> {
  const v = variables(env);
  const x = await loadIntegrations(env).catch(() => ({}) as Awaited<ReturnType<typeof loadIntegrations>>);
  env.BITRIX_WEBHOOK_URL = v.BITRIX_WEBHOOK_URL || x.bitrix || "";
  const zoom = v.ZOOM_ACCOUNT_ID ? null : x.zoom;
  env.ZOOM_ACCOUNT_ID = zoom?.accountId ?? v.ZOOM_ACCOUNT_ID;
  env.ZOOM_CLIENT_ID = zoom?.clientId ?? v.ZOOM_CLIENT_ID;
  env.ZOOM_CLIENT_SECRET = zoom?.clientSecret ?? v.ZOOM_CLIENT_SECRET;
  // The Google client the owner sent to the bot, unless the deployment has one.
  const google = v.GOOGLE_CLIENT_ID ? null : x.google;
  env.GOOGLE_CLIENT_ID = google?.i ?? v.GOOGLE_CLIENT_ID;
  env.GOOGLE_CLIENT_SECRET = google?.s ?? v.GOOGLE_CLIENT_SECRET;
  env.GOOGLE_OAUTH_MODE = google ? (google.d === false ? "web" : "desktop") : v.GOOGLE_OAUTH_MODE;
  env.GOOGLE_PROJECT_ID = google ? (google.p ?? "") : v.GOOGLE_PROJECT_ID;
}
