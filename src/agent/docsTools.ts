import type { Env } from "../env";
import { textPart } from "../lib/parse";
import { type DriveFile, type FilePage, MIME, Workspace } from "../google/workspace";
import { fileText } from "./files";
import { str, type Tool } from "./runner";

/**
 * The Docs Agent's tools: Google Drive, Sheets and Docs. Reading, creating, adding, changing values, moving and sharing.
 * Nothing can be deleted, trashed or cleared — there is no such tool, and a sheet update that would blank cells is
 * refused.
 */

const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required });
const s = (description: string) => ({ type: "string", description });
const rowsSchema = (description: string) => ({ type: "array", items: { type: "array", items: { type: "string" } }, description });

const KIND: Record<string, string> = { [MIME.folder]: "папка", [MIME.doc]: "документ", [MIME.sheet]: "таблиця", [MIME.slides]: "презентація" };

function brief(f: DriveFile): Record<string, unknown> {
  return { id: f.id, name: f.name, type: KIND[f.mimeType] ?? f.mimeType, modified: f.modifiedTime, link: f.webViewLink };
}

const rowsOf = (v: unknown): string[][] => (Array.isArray(v) ? v.map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? "")) : [String(r ?? "")])) : []);
const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 1);
/** A page of files for the model, with the token for the next page when there is one. */
const listed = (p: FilePage) => ({ files: p.files.map(brief), ...(p.next ? { nextPage: p.next, note: "Є ще файли. Не гортай усе: покажи найсвіжіші й попроси власника уточнити назву, рік, папку чи тип; page=nextPage — лише на «покажи ще»" } : {}) });
const PART = { type: "number", description: "Which part of a long text, from 1 (the answer says how many parts there are)" };
const PAGE_TOKEN = s("nextPage from the previous answer, to get the next files");

export function docsTools(env: Env): Tool[] {
  const ws = new Workspace(env);
  return [
    {
      spec: {
        name: "drive_search",
        description: "Find files on the owner's Google Drive by words in the name or text (newest first), 25 at a time; nextPage gives the next ones.",
        parameters: object(
          {
            query: s("Words to find; empty for the latest files"),
            type: { type: "string", enum: ["any", "doc", "sheet", "folder", "slides"], description: "Kind of file" },
            page: PAGE_TOKEN,
          },
          ["query"],
        ),
      },
      async run(a) {
        const type = str(a, "type");
        return listed(await ws.search(str(a, "query"), type && type !== "any" ? (type as keyof typeof MIME) : undefined, str(a, "page") || undefined));
      },
    },
    {
      spec: {
        name: "drive_read",
        description:
          "Read a Drive file: a Doc, a Sheet (every tab, every row), Slides, a folder's contents, or a PDF / Word / Excel file. A long text comes in parts — read the next with part; a big folder in pages — the next with page. Question — what to find in it (for a PDF).",
        parameters: object(
          { fileId: s("File ID from drive_search"), question: s("What the owner wants to know; empty for the content"), part: PART, page: PAGE_TOKEN },
          ["fileId"],
        ),
      },
      async run(a) {
        const f = await ws.file(str(a, "fileId"));
        const head = { ...brief(f) };
        const part = num(a.part);
        if (f.mimeType === MIME.folder) return { ...head, ...listed(await ws.list(f.id, str(a, "page") || undefined)) };
        if (f.mimeType === MIME.doc || f.mimeType === MIME.slides) return { ...head, text: textPart(await ws.export(f.id, "text/plain"), part) };
        if (f.mimeType === MIME.sheet) {
          const info = await ws.sheetTitles(f.id);
          // Each whole tab (its name as the range = every filled cell).
          const tabs = await Promise.all(
            info.sheets.map(async (t) => `## ${t}\n${(await ws.readRange(f.id, `'${t.replace(/'/g, "''")}'`)).map((r) => r.join(" | ")).join("\n")}`),
          );
          return { ...head, sheets: info.sheets, text: textPart(tabs.join("\n\n"), part) };
        }
        // A file the model gets whole (a PDF): above this size the request to the model fails anyway.
        if (Number(f.size ?? 0) > 20_000_000) return { ...head, error: "Файл завеликий (понад 20 МБ)." };
        return { ...head, text: await fileText(env, await ws.download(f.id), f.name, f.mimeType, str(a, "question"), part) };
      },
    },
    {
      spec: {
        name: "sheets_read",
        description: "Read cells of a Google Sheet, e.g. range «Витрати!A1:F50» or just a tab name.",
        parameters: object({ spreadsheetId: s("Spreadsheet ID"), range: s("A1 range or tab name") }, ["spreadsheetId", "range"]),
      },
      async run(a) {
        return { range: str(a, "range"), rows: await ws.readRange(str(a, "spreadsheetId"), str(a, "range")) };
      },
    },
    {
      spec: {
        name: "sheets_append",
        description: "Add rows at the end of a table in a Google Sheet. Only after the owner confirmed the preview.",
        parameters: object(
          { spreadsheetId: s("Spreadsheet ID"), range: s("Tab name (or A1 range of the table)"), rows: rowsSchema("Rows to add, each a list of cell values") },
          ["spreadsheetId", "range", "rows"],
        ),
      },
      async run(a) {
        const rows = rowsOf(a.rows);
        if (!rows.length) return { ok: false, error: "No rows" };
        return { ok: true, ...(await ws.appendRows(str(a, "spreadsheetId"), str(a, "range"), rows)) };
      },
    },
    {
      spec: {
        name: "sheets_update",
        description: "Write values into cells of a Google Sheet. Only after the owner confirmed the preview. Never used to erase: empty values are refused.",
        parameters: object(
          { spreadsheetId: s("Spreadsheet ID"), range: s("A1 range, e.g. «Витрати!C5»"), rows: rowsSchema("New values, row by row") },
          ["spreadsheetId", "range", "rows"],
        ),
      },
      async run(a) {
        const rows = rowsOf(a.rows);
        // Nothing is deleted: blanking cells is not a change the bot makes.
        if (!rows.length || rows.some((r) => r.some((c) => c.trim() === ""))) {
          return { ok: false, error: "Refused: the bot never erases cells. Give a value for every cell." };
        }
        return { ok: true, ...(await ws.updateRange(str(a, "spreadsheetId"), str(a, "range"), rows)) };
      },
    },
    {
      spec: {
        name: "sheets_create",
        description: "Create a new Google Sheet, optionally with a header row.",
        parameters: object({ title: s("Title"), header: { type: "array", items: { type: "string" }, description: "Column names" } }, ["title"]),
      },
      async run(a) {
        return ws.createSheet(str(a, "title"), Array.isArray(a.header) ? a.header.map(String) : []);
      },
    },
    {
      spec: {
        name: "docs_create",
        description: "Create a new Google Doc with the given text.",
        parameters: object({ title: s("Title"), text: s("The document's text") }, ["title", "text"]),
      },
      async run(a) {
        return ws.createDoc(str(a, "title"), str(a, "text"));
      },
    },
    {
      spec: {
        name: "docs_append",
        description: "Add text at the end of a Google Doc. Only after the owner confirmed the preview.",
        parameters: object({ documentId: s("Document ID"), text: s("Text to add") }, ["documentId", "text"]),
      },
      async run(a) {
        await ws.appendText(str(a, "documentId"), str(a, "text"));
        return { ok: true, link: `https://docs.google.com/document/d/${str(a, "documentId")}/edit` };
      },
    },
    {
      spec: {
        name: "drive_create_folder",
        description: "Create a folder on Google Drive (inside another folder if parentId is given).",
        parameters: object({ name: s("Folder name"), parentId: s("Parent folder ID; empty for My Drive") }, ["name"]),
      },
      async run(a) {
        return brief(await ws.createFolder(str(a, "name"), str(a, "parentId") || undefined));
      },
    },
    {
      spec: {
        name: "drive_move",
        description: "Move a file into a folder. Only after the owner confirmed.",
        parameters: object({ fileId: s("File ID"), folderId: s("Target folder ID") }, ["fileId", "folderId"]),
      },
      async run(a) {
        return brief(await ws.move(str(a, "fileId"), str(a, "folderId")));
      },
    },
    {
      spec: {
        name: "drive_share",
        description: "Give a person access to a file (they get an email from Google). Only after the owner confirmed.",
        parameters: object(
          { fileId: s("File ID"), email: s("Person's email"), role: { type: "string", enum: ["reader", "commenter", "writer"], description: "Access level" } },
          ["fileId", "email", "role"],
        ),
      },
      async run(a) {
        const role = str(a, "role");
        await ws.share(str(a, "fileId"), str(a, "email"), role === "writer" || role === "commenter" ? role : "reader");
        return { ok: true };
      },
    },
  ];
}
