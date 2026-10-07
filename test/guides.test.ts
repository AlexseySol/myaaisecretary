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
  it("/help: the main menu's buttons lead to the guides, notes and settings; the Google tab (no client yet) lists the 6 APIs and asks for the file", async () => {
    const calls = mockFetch([]);
    const { env } = testEnv({ GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" });
    await handleUpdate(env, say("/help"));
    const help = tgCalls(calls, "sendMessage").at(-1)!;
    for (const data of ["guide:menu", "menu:notes", "set:open"]) expect(JSON.stringify(help.reply_markup)).toContain(data);
    await handleUpdate(env, press("guide:menu"));
    const menu = tgCalls(calls, "sendMessage").at(-1)!;
    expect(JSON.stringify(menu.reply_markup)).toContain("guide:google");
    expect(JSON.stringify(menu.reply_markup)).toContain("guide:bitrix");

    await handleUpdate(env, press("guide:google"));
    const sent = String(tgCalls(calls, "sendMessage").at(-1)!.text);
    expect(sent).toContain("крок 1 із 2");
    for (const api of ["calendar-json", "gmail", "drive", "sheets", "docs", "pubsub"]) expect(sent).toContain(`apis/library/${api}.googleapis.com`);
    expect(sent).toContain("Desktop app");
    expect(sent).toContain("Надішліть цей файл");
    // The project's video comes with it until the owner adds their own.
    expect(sent).toContain('🎥 <b>Відео:</b> <a href="https://drive.google.com/file/d/1o1UOKdoZSm1j-d3cSjSd4-tVVB0HjeGh/view">Гугл</a>');

    await handleUpdate(env, press("guide:telegram"));
    expect(String(tgCalls(calls, "sendMessage").at(-1)!.text)).toContain("@BotFather");
    await handleUpdate(env, press("guide:bitrix"));
    const bitrix = tgCalls(calls, "sendMessage").at(-1)!;
    expect(String(bitrix.text)).toContain("Вхідний вебхук");
    expect(JSON.stringify(bitrix.reply_markup)).toContain("set:on:bitrix");
  });

  it("a video sent in reply to a guide is kept and shown with it from then on", async () => {
    const calls = mockFetch([]);
    const { env } = testEnv();
    await handleUpdate(env, press("guide:google"));
    const guide = lastBotMessage("Google —");
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
    expect(String(tgCalls(calls, "sendMessage").at(-1)!.text)).not.toContain("drive.google.com");
  });
});
