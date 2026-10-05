/**
 * Text that is safe to send anywhere. A string cut in the middle of an emoji («📋» is two UTF-16 units) keeps half of
 * it — a lone surrogate. JSON.stringify writes it as "\ud83d", which some model providers reject as invalid JSON, and a
 * broken string kept in the chat memory then breaks every later request. So: cut on whole characters, and clean every
 * string of a request body.
 */

const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** The string with any half-character replaced by «�». */
export function wellFormed(s: string): string {
  return s.replace(LONE, "�");
}

/** At most `n` UTF-16 units, never ending in half an emoji; «…» when cut. */
export function cutText(s: string, n: number, ellipsis = "…"): string {
  if (s.length <= n) return s;
  let end = n;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return `${s.slice(0, end)}${ellipsis}`;
}

/** JSON for a request body, every string made well-formed first. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "string" ? wellFormed(v) : v));
}
