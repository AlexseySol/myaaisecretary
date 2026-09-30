import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadOwnerSettings } from "../src/google/oauth";
import { handleUpdate } from "../src/telegram/handler";
import type { TgUpdate } from "../src/telegram/types";
import { lastBotMessage, mockFetch, OWNER, resetInstance, testEnv, tgCalls } from "./helpers";

beforeEach(() => resetInstance());
afterEach(() => vi.restoreAllMocks());

const from = { id: OWNER, is_bot: false, first_name: "О" };
const press = (data: string): TgUpdate => ({ update_id: 1, callback_query: { id: "c", from, data, message: { message_id: 5, date: 0, chat: { id: OWNER, type: "private" } } } });
const say = (text: string): TgUpdate => ({ update_id: 2, message: { message_id: 6, date: 0, chat: { id: OWNER, type: "private" }, from, text } });

describe("📖 guides inside the bot", () => {
  it("/help offers Google, Telegram and Bitrix24; the Google guide lists the 6 APIs, linked to the owner's project", async () => {
    const calls = mockFetch([]);
    const { env } = testEnv({ GOOGLE_PROJECT_ID: "my-proj" });
    await handleUpdate(env, say("/help"));
    const help = tgCalls(calls, "sendMessage").at(-1)!;
    expect(JSON.stringify(help.reply_markup)).toContain("guide:google");
    expect(JSON.stringify(help.reply_markup)).toContain("guide:bitrix");

    await handleUpdate(env, press("guide:google"));
    const text = String(lastBotMessage("Google: що увімкнути").text);
    for (const api of ["Google Calendar API", "Gmail API", "Google Drive API", "Google Sheets API", "Google Docs API", "Cloud Pub/Sub API"]) expect(text).toContain(api);
    const sent = String(tgCalls(calls, "sendMessage").at(-1)!.text);
    expect(sent).toContain("pubsub.googleapis.com?project=my-proj");
    expect(sent).toContain("Desktop app");
    // The project's video comes with it until the owner adds their own.
    expect(JSON.stringify(tgCalls(calls, "sendMessage").at(-1)!.reply_markup)).toContain("drive.google.com/file/d/1o1UOKdoZSm1j");

    await handleUpdate(env, press("guide:telegram"));
    expect(String(tgCalls(calls, "sendMessage").at(-1)!.text)).toContain("@BotFather");
    await handleUpdate(env, press("guide:bitrix"));
    expect(String(tgCalls(calls, "sendMessage").at(-1)!.text)).toContain("Вхідний вебхук");
  });

  it("a video sent in reply to a guide is kept and shown with it from then on", async () => {
    const calls = mockFetch([]);
    const { env } = testEnv();
    await handleUpdate(env, press("guide:google"));
    const guide = lastBotMessage("Google: що увімкнути");
    await handleUpdate(env, {
      update_id: 3,
      message: { message_id: 7, date: 0, chat: { id: OWNER, type: "private" }, from, reply_to_message: guide, video: { file_id: "VID1", file_unique_id: "u" } },
    });
    expect((await loadOwnerSettings(env)).gv).toEqual({ google: { f: "VID1", t: "video" } });
    expect(String(tgCalls(calls, "sendMessage").at(-1)!.text)).toContain("Відео додано");

    // A question in reply to the guide is not a command: the video stays.
    const { handleGuideReply } = await import("../src/bot/guides");
    const reply = (text: string) => ({ message_id: 8, date: 0, chat: { id: OWNER, type: "private" as const }, from, reply_to_message: guide, text });
    expect(await handleGuideReply(env, reply("а як видалити доступ у Google?"))).toBe(false);
    expect((await loadOwnerSettings(env)).gv?.google?.f).toBe("VID1");

    await handleUpdate(env, press("guide:google"));
    expect(tgCalls(calls, "sendVideo").at(-1)).toMatchObject({ video: "VID1" });
    expect(await handleGuideReply(env, reply("прибери відео"))).toBe(true);
    expect((await loadOwnerSettings(env)).gv).toEqual({});
    expect(JSON.stringify(tgCalls(calls, "sendMessage").at(-1)!.reply_markup ?? {})).not.toContain("drive.google.com");
  });
});
