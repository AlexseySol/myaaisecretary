import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { docsTools } from "../src/agent/docsTools";
import { routeByKeywords } from "../src/agent/route";
import { MAX_TEXT, parseDocument, textPart } from "../src/lib/parse";
import { buildXlsx, zip } from "../src/lib/xlsx";
import { missingScopes } from "../src/google/oauth";
import { handleUpdate } from "../src/telegram/handler";
import { connectGoogle, type LlmRequest, llmText, mockFetch, OWNER, openRouter, resetInstance, runJobs, testEnv } from "./helpers";

beforeEach(() => resetInstance());
afterEach(() => vi.restoreAllMocks());

const enc = (s: string) => new TextEncoder().encode(s);
const docx = (paragraphs: string[]) =>
  zip([["word/document.xml", enc(`<w:document><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`)]]);

describe("parsers: files read without dependencies", () => {
  it("Word, Excel, CSV; a PDF goes to the model as a file", () => {
    expect(parseDocument(docx(["Договір № 12", "Сума: 15 000 грн &amp; ПДВ"]), "dogovir.docx")).toEqual({ kind: "text", text: "Договір № 12\nСума: 15 000 грн & ПДВ" });
    const xlsx = buildXlsx([{ name: "Витрати", rows: [["Дата", "Що", "Сума"], ["30.09", "Таксі", 1200]] }]);
    const sheet = parseDocument(xlsx, "vytraty.xlsx");
    expect(sheet.kind).toBe("text");
    expect((sheet as { text: string }).text).toContain("## Витрати");
    expect((sheet as { text: string }).text).toContain("30.09 | Таксі | 1200");
    expect(parseDocument(enc("a,b\n1,2"), "x.csv")).toEqual({ kind: "text", text: "a,b\n1,2" });
    expect(parseDocument(enc("%PDF-1.4"), "scan.pdf").kind).toBe("pdf");
    expect(parseDocument(enc("??"), "photo.heic").kind).toBe("unknown");
  });
});

describe("the Docs Agent never deletes", () => {
  it("has no tool that deletes, trashes or clears; blanking cells is refused", async () => {
    const { env } = testEnv();
    const tools = docsTools(env);
    expect(tools.map((t) => t.spec.name).join(" ")).not.toMatch(/delete|trash|remove|clear|erase/);
    const update = tools.find((t) => t.spec.name === "sheets_update")!;
    expect(await update.run({ spreadsheetId: "s1", range: "A1:B1", rows: [["", "x"]] })).toMatchObject({ ok: false });
  });

  it("Drive, sheet and document requests go straight to it; two topics to the Supervisor", () => {
    const route = (text: string) => routeByKeywords({ chatId: OWNER, inputType: "text", text }, true);
    expect(route("знайди таблицю витрат")).toBe("docs_agent");
    expect(route("що в документі про оренду?")).toBe("docs_agent");
    expect(route("створи папку Звіти на гугл диску")).toBe("docs_agent");
    expect(route("надішли Івану лист з цим документом")).toBeNull();
    expect(route("Excel-звіт по задачах")).toBe("bitrix_agent");
  });

  it("asks for the Drive permission when it is missing (exact scope, not the hidden folder one)", () => {
    expect(missingScopes("https://www.googleapis.com/auth/drive.appdata").join(" ")).toContain("документи");
    expect(missingScopes("https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive").join(" ")).not.toContain("документи");
  });
});

describe("no file is out of reach: long texts in parts, many files in pages", () => {
  it("a long text is never cut off for good — each part says how many there are", () => {
    const text = "а".repeat(MAX_TEXT) + "б".repeat(MAX_TEXT) + "кінець";
    expect(textPart(text)).toContain("частина 1 з 3; далі — part=2");
    expect(textPart(text, 3)).toContain("кінець");
    expect(textPart(text, 3)).toContain("частина 3 з 3)");
    expect(textPart("коротко")).toBe("коротко");
  });

  it("Drive search gives the next page's token; a sheet is read whole, every tab", async () => {
    await connectGoogle();
    const ranges: string[] = [];
    mockFetch([
      (url) => {
        if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/files") {
          const second = url.searchParams.get("pageToken") === "p2";
          return Response.json({ files: [{ id: second ? "f2" : "f1", name: "x", mimeType: "text/plain" }], ...(second ? {} : { nextPageToken: "p2" }) });
        }
        if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/files/s1") return Response.json({ id: "s1", name: "Витрати", mimeType: "application/vnd.google-apps.spreadsheet" });
        if (url.hostname === "sheets.googleapis.com" && url.pathname.endsWith("/s1")) return Response.json({ properties: { title: "Витрати" }, spreadsheetUrl: "u", sheets: ["1", "2", "3", "4", "5", "6"].map((t) => ({ properties: { title: `Аркуш${t}` } })) });
        if (url.hostname === "sheets.googleapis.com") {
          ranges.push(decodeURIComponent(url.pathname.split("/values/")[1]!));
          return Response.json({ values: [["рядок"]] });
        }
        return undefined;
      },
    ]);
    const { env } = testEnv();
    const tools = docsTools(env);
    const search = tools.find((t) => t.spec.name === "drive_search")!;
    expect(await search.run({ query: "x" })).toMatchObject({ files: [{ id: "f1" }], nextPage: "p2" });
    expect(await search.run({ query: "x", page: "p2" })).toEqual({ files: [expect.objectContaining({ id: "f2" })] });
    const read = tools.find((t) => t.spec.name === "drive_read")!;
    await read.run({ fileId: "s1" });
    expect(ranges).toHaveLength(6);
    expect(ranges[0]).toBe("'Аркуш1'");
  });
});

describe("a file sent to the bot", () => {
  it("a Word file's text reaches the agents; a PDF goes as a file the model reads", async () => {
    await connectGoogle();
    const seen: LlmRequest[] = [];
    let file = docx(["Рахунок № 7 від 30.09.2026", "До сплати: 4 800 грн"]);
    mockFetch([
      (url) => (url.hostname === "api.telegram.org" && url.pathname.includes("/file/bot") ? new Response(new Uint8Array(file)) : undefined),
      openRouter(() => llmText("До сплати 4 800 грн."), seen),
    ]);
    const { env, jobs } = testEnv();
    const send = (name: string, mime: string) =>
      handleUpdate(env, {
        update_id: 1,
        message: { message_id: 9, date: 0, chat: { id: OWNER, type: "private" }, from: { id: OWNER, is_bot: false, first_name: "О" }, caption: "скільки платити?", document: { file_id: "F1", file_unique_id: "u", file_name: name, mime_type: mime } },
      });
    await send("rahunok.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    await runJobs(env, jobs);
    expect(JSON.stringify(seen[0]!.messages)).toContain("До сплати: 4 800 грн");

    file = enc("%PDF-1.4 test");
    await send("rahunok.pdf", "application/pdf");
    await runJobs(env, jobs);
    const req = seen.at(-1)! as LlmRequest & { plugins?: unknown };
    expect(JSON.stringify(req.messages)).toContain('"type":"file"');
    expect(req.plugins).toEqual([{ id: "file-parser", pdf: { engine: "pdf-text" } }]);
  });
});

describe("an email's attachment", () => {
  it("attachment_read opens a Word file from a letter", async () => {
    await connectGoogle();
    const file = docx(["Акт виконаних робіт", "Разом: 9 900 грн"]);
    mockFetch([
      (url) => {
        if (url.hostname !== "gmail.googleapis.com") return undefined;
        if (url.pathname.includes("/attachments/")) return Response.json({ data: Buffer.from(file).toString("base64url") });
        return Response.json({ id: "m1", threadId: "t", payload: { parts: [{ mimeType: "text/plain", body: { data: "" } }, { filename: "akt.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", body: { attachmentId: "A1" } }] } });
      },
    ]);
    const { env } = testEnv();
    const { gmailTools } = await import("../src/agent/gmailTools");
    const read = gmailTools(env).find((t) => t.spec.name === "attachment_read")!;
    expect(await read.run({ MessageId: "m1" })).toEqual([{ name: "akt.docx", content: "Акт виконаних робіт\nРазом: 9 900 грн" }]);
  });
});

describe("long messages", () => {
  it("a text over Telegram's limit goes as several messages, the buttons with the last", async () => {
    const { splitMessage, Telegram } = await import("../src/telegram/api");
    const long = Array.from({ length: 120 }, (_, i) => `• <b>Рядок ${i}</b> — ${"текст ".repeat(8)}`).join("\n");
    const parts = splitMessage(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 4000)).toBe(true);
    expect(parts.join("\n").replace(/\s+/g, " ").trim()).toBe(long.replace(/\s+/g, " ").trim());
    const { tgCalls } = await import("./helpers");
    const calls = mockFetch([]);
    const { env } = testEnv();
    await new Telegram(env).send(OWNER, long, { keyboard: [[{ text: "ok", callback_data: "x" }]] });
    const sent = tgCalls(calls, "sendMessage");
    expect(sent.length).toBe(parts.length);
    expect(sent.at(-1)!.reply_markup).toBeTruthy();
    expect(sent[0]!.reply_markup).toBeUndefined();
  });
});
