export type SourceType = "text" | "voice" | "forward" | "screenshot";

/**
 * Short-lived, in-memory state of the current server instance — nothing is persisted, everything expires by
 * itself. Serverless instances are reused between requests that follow each other closely, which is exactly
 * what this is for: gluing a burst of forwarded messages into one card, remembering which card the owner was
 * asked to edit, not reporting the same calendar change twice. Losing it costs a duplicate, never data.
 */

const marks = new Map<string, number>();

function sweep(now = Date.now()): void {
  for (const [key, until] of marks) if (until <= now) marks.delete(key);
  for (const [chat, batch] of batches) if (batch.at < now - BATCH_TTL_MS) batches.delete(chat);
  for (const [chat, p] of pending) if (p.until <= now) pending.delete(chat);
}

/** True the first time `key` is seen within `ttlMs` (then remembers it). */
export function firstTime(key: string, ttlMs: number): boolean {
  sweep();
  if (marks.has(key)) return false;
  marks.set(key, Date.now() + ttlMs);
  return true;
}

export function mark(key: string, ttlMs: number): void {
  marks.set(key, Date.now() + ttlMs);
}

export function isMarked(key: string): boolean {
  sweep();
  return marks.has(key);
}

// ---------------------------------------------------------------------------------------------------------------
// A burst of forwarded messages / screenshots

export interface Batch {
  lines: string[];
  sourceType: SourceType;
  seq: number;
  messageId: number | null;
  at: number;
}

const BATCH_TTL_MS = 5 * 60_000;
const batches = new Map<number, Batch>();

/** Adds a message to the chat's batch; `seq` identifies the latest message (debounce). */
export function appendBatch(chatId: number, line: string, sourceType: SourceType): Batch {
  sweep();
  const batch = batches.get(chatId) ?? { lines: [], sourceType, seq: 0, messageId: null, at: Date.now() };
  batch.lines.push(line);
  if (batch.sourceType !== "forward") batch.sourceType = sourceType;
  batch.seq++;
  batch.at = Date.now();
  batches.set(chatId, batch);
  return batch;
}

/** The batch, if `seq` is still its latest message (no newer message arrived); removes it. */
export function takeBatch(chatId: number, seq: number): Batch | null {
  const batch = batches.get(chatId);
  if (!batch || batch.seq !== seq) return null;
  batches.delete(chatId);
  return batch;
}

// ---------------------------------------------------------------------------------------------------------------
// What the bot just asked the owner to answer (when the answer does not come as a reply)

const pending = new Map<number, { data: unknown; until: number }>();
const PENDING_TTL_MS = 30 * 60_000;

export function expectAnswer(chatId: number, data: unknown): void {
  pending.set(chatId, { data, until: Date.now() + PENDING_TTL_MS });
}

export function takeAnswer<T>(chatId: number): T | null {
  sweep();
  const p = pending.get(chatId);
  if (!p) return null;
  pending.delete(chatId);
  return p.data as T;
}

export function clearAnswer(chatId: number): void {
  pending.delete(chatId);
}

// ---------------------------------------------------------------------------------------------------------------
// The owner's messages, glued and one at a time (Telegram bots' usual practice)
//
// People write in bursts: «ставь на робочу» + «ну точніше переделай» a second apart, a long text Telegram split, an
// album. Each message waits a moment (INBOX_WAIT_S) in the chat's inbox; the latest one's job takes them all as ONE
// request. And a chat runs one request at a time: what arrives meanwhile waits and goes next, glued together.

/** How long the bot waits for the next message of a burst. */
export const INBOX_WAIT_S = 2.5;

export interface InboxItem {
  text: string;
  inputType: "text" | "photo" | "document";
  replyText?: string | null;
  replyRef?: string | null;
  photoIds: string[];
  files: { id: string; name: string; mime: string }[];
  messageId: number;
}

const inboxes = new Map<number, { items: InboxItem[]; seq: number }>();

/** Adds a message to the chat's inbox; returns its number (the job of the latest one takes them all). */
export function pushInbox(chatId: number, item: InboxItem): number {
  const box = inboxes.get(chatId) ?? { items: [], seq: 0 };
  box.items.push(item);
  box.seq++;
  inboxes.set(chatId, box);
  return box.seq;
}

/** Whether no newer message arrived after `seq`. */
export function isLatest(chatId: number, seq: number): boolean {
  return inboxes.get(chatId)?.seq === seq;
}

/** Everything waiting in the chat's inbox, oldest first (the inbox is left empty). */
export function drainInbox(chatId: number): InboxItem[] {
  const box = inboxes.get(chatId);
  if (!box) return [];
  const items = box.items;
  box.items = [];
  return items;
}

const running = new Map<number, Promise<void>>();

/** Runs `fn` after the chat's request in progress (if any) has finished: a chat's requests never overlap. */
export async function oneAtATime<T>(chatId: number, fn: () => Promise<T>): Promise<T> {
  const before = running.get(chatId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chain = before.then(() => mine);
  running.set(chatId, chain);
  await before;
  try {
    return await fn();
  } finally {
    release();
    if (running.get(chatId) === chain) running.delete(chatId);
  }
}

/** Tests: start from a clean instance. */
export function resetSession(): void {
  marks.clear();
  batches.clear();
  pending.clear();
  inboxes.clear();
  running.clear();
}
