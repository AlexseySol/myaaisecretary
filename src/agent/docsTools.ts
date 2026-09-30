import type { Env } from "../env";
import { MAX_TEXT } from "../lib/parse";
import { type DriveFile, MIME, Workspace } from "../google/workspace";
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
const cut = (t: string) => (t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}\n…(далі обрізано)` : t);

export function docsTools(env: Env): Tool[] {
  const ws = new Workspace(env);
  return [
    {
      spec: {
        name: "drive_search",
        description: "Find files on the owner's Google Drive by words in the name or text (newest first).",
        parameters: object(
          { query: s("Words to find; empty for the latest files"), type: { type: "string", enum: ["any", "doc", "sheet", "folder", "slides"], description: "Kind of file" } },
          ["query"],
        ),
      },
      async run(a) {
        const type = str(a, "type");
        return (await ws.search(str(a, "query"), type && type !== "any" ? (type as keyof typeof MIME) : undefined)).map(brief);
      },
    },
    {
      spec: {
        name: "drive_read",
        description: "Read a Drive file: a Doc, a Sheet (all tabs), Slides, a folder's contents, or a PDF / Word / Excel file. Question — what to find in it (for a PDF).",
        parameters: object({ fileId: s("File ID from drive_search"), question: s("What the owner wants to know; empty for the content") }, ["fileId"]),
      },
      async run(a) {
        const f = await ws.file(str(a, "fileId"));
        const head = { ...brief(f) };
        if (f.mimeType === MIME.folder) return { ...head, files: (await ws.list(f.id)).map(brief) };
        if (f.mimeType === MIME.doc) return { ...head, text: cut(await ws.export(f.id, "text/plain")) };
        if (f.mimeType === MIME.slides) return { ...head, text: cut(await ws.export(f.id, "text/plain")) };
        if (f.mimeType === MIME.sheet) {
          const info = await ws.sheetTitles(f.id);
          const tabs = await Promise.all(
            info.sheets.slice(0, 5).map(async (t) => `## ${t}\n${(await ws.readRange(f.id, `'${t.replace(/'/g, "''")}'!A1:Z300`)).map((r) => r.join(" | ")).join("\n")}`),
          );
          return { ...head, sheets: info.sheets, text: cut(tabs.join("\n\n")) };
        }
        if (Number(f.size ?? 0) > 20_000_000) return { ...head, error: "Файл завеликий (понад 20 МБ)." };
        return { ...head, text: await fileText(env, await ws.download(f.id), f.name, f.mimeType, str(a, "question")) };
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
