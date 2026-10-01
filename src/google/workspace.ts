import type { Env } from "../env";
import { expectOk, fetchWithRetry } from "../lib/http";
import { getAccessToken, loadGrant } from "./oauth";

/**
 * The owner's Google Drive, Sheets and Docs (scope drive). Only reading, creating, adding, changing values, moving and
 * sharing — there is deliberately no method that deletes, trashes or clears anything.
 */

const DRIVE = "https://www.googleapis.com/drive/v3/files";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const DOCS = "https://docs.googleapis.com/v1/documents";

export const MIME = {
  folder: "application/vnd.google-apps.folder",
  doc: "application/vnd.google-apps.document",
  sheet: "application/vnd.google-apps.spreadsheet",
  slides: "application/vnd.google-apps.presentation",
} as const;

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
  size?: string;
  parents?: string[];
}

const FIELDS = "id,name,mimeType,modifiedTime,webViewLink,size,parents";
/** Files per page of a search or a folder; the next page comes with `next`, so nothing is out of reach. */
const PAGE = 25;

export interface FilePage {
  files: DriveFile[];
  /** The next page's token; none when this is the last page. */
  next?: string;
}

/** Whether the owner allowed the bot into Drive, Sheets and Docs (the full drive scope, not only its hidden folder). */
export async function hasWorkspaceScope(env: Env): Promise<boolean> {
  const scope = (await loadGrant(env))?.scope ?? "";
  return scope.split(/\s+/).includes("https://www.googleapis.com/auth/drive");
}

export class Workspace {
  constructor(private readonly env: Env) {}

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await getAccessToken(this.env);
    const res = await fetchWithRetry(url, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
    });
    return expectOk(`google ${init.method ?? "GET"} ${new URL(url).hostname}`, res);
  }

  private async json<T>(url: string, init: RequestInit = {}): Promise<T> {
    return (await (await this.request(url, init)).json()) as T;
  }

  /** Files whose name or text contains the words (newest first), a page at a time; trashed files are left out. */
  async search(text: string, type?: keyof typeof MIME, page?: string, limit = PAGE): Promise<FilePage> {
    const q = ["trashed = false"];
    const words = text.replace(/'/g, "\\'").trim();
    if (words) q.push(`(name contains '${words}' or fullText contains '${words}')`);
    if (type) q.push(`mimeType = '${MIME[type]}'`);
    return this.page(q.join(" and "), page, limit);
  }

  /** What a folder holds (newest first), a page at a time. */
  async list(folder: string, page?: string, limit = PAGE): Promise<FilePage> {
    return this.page(`'${folder.replace(/'/g, "\\'")}' in parents and trashed = false`, page, limit);
  }

  private async page(q: string, page: string | undefined, limit: number): Promise<FilePage> {
    const params = new URLSearchParams({ q, fields: `nextPageToken,files(${FIELDS})`, pageSize: String(limit), orderBy: "modifiedTime desc" });
    if (page) params.set("pageToken", page);
    const r = await this.json<{ files?: DriveFile[]; nextPageToken?: string }>(`${DRIVE}?${params}`);
    return { files: r.files ?? [], next: r.nextPageToken };
  }

  async file(id: string): Promise<DriveFile> {
    return this.json<DriveFile>(`${DRIVE}/${encodeURIComponent(id)}?fields=${FIELDS}`);
  }

  /** A Google Doc / Sheet / Slides as text or CSV. */
  async export(id: string, mime: string): Promise<string> {
    return (await this.request(`${DRIVE}/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(mime)}`)).text();
  }

  async download(id: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.request(`${DRIVE}/${encodeURIComponent(id)}?alt=media`)).arrayBuffer());
  }

  async createFolder(name: string, parent?: string): Promise<DriveFile> {
    return this.json<DriveFile>(`${DRIVE}?fields=${FIELDS}`, {
      method: "POST",
      body: JSON.stringify({ name, mimeType: MIME.folder, ...(parent ? { parents: [parent] } : {}) }),
    });
  }

  /** Moves a file into a folder (it leaves its old folders — nothing is deleted). */
  async move(id: string, folder: string): Promise<DriveFile> {
    const current = await this.file(id);
    const params = new URLSearchParams({ addParents: folder, fields: FIELDS });
    if (current.parents?.length) params.set("removeParents", current.parents.join(","));
    return this.json<DriveFile>(`${DRIVE}/${encodeURIComponent(id)}?${params}`, { method: "PATCH", body: "{}" });
  }

  async share(id: string, email: string, role: "reader" | "commenter" | "writer"): Promise<void> {
    await this.request(`${DRIVE}/${encodeURIComponent(id)}/permissions?sendNotificationEmail=true`, {
      method: "POST",
      body: JSON.stringify({ type: "user", role, emailAddress: email }),
    });
  }

  // Sheets

  async sheetTitles(id: string): Promise<{ title: string; url: string; sheets: string[] }> {
    const s = await this.json<{ properties: { title: string }; spreadsheetUrl: string; sheets?: { properties: { title: string } }[] }>(
      `${SHEETS}/${encodeURIComponent(id)}?fields=properties.title,spreadsheetUrl,sheets.properties.title`,
    );
    return { title: s.properties.title, url: s.spreadsheetUrl, sheets: (s.sheets ?? []).map((x) => x.properties.title) };
  }

  async readRange(id: string, range: string): Promise<string[][]> {
    return (await this.json<{ values?: string[][] }>(`${SHEETS}/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}`)).values ?? [];
  }

  async appendRows(id: string, range: string, rows: unknown[][]): Promise<{ updatedRange?: string }> {
    const r = await this.json<{ updates?: { updatedRange?: string } }>(
      `${SHEETS}/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      { method: "POST", body: JSON.stringify({ values: rows }) },
    );
    return { updatedRange: r.updates?.updatedRange };
  }

  async updateRange(id: string, range: string, rows: unknown[][]): Promise<{ updatedRange?: string }> {
    return this.json(`${SHEETS}/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
      method: "PUT",
      body: JSON.stringify({ values: rows }),
    });
  }

  async createSheet(title: string, header: string[] = []): Promise<{ id: string; url: string }> {
    const s = await this.json<{ spreadsheetId: string; spreadsheetUrl: string }>(SHEETS, { method: "POST", body: JSON.stringify({ properties: { title } }) });
    if (header.length) await this.updateRange(s.spreadsheetId, "A1", [header]);
    return { id: s.spreadsheetId, url: s.spreadsheetUrl };
  }

  // Docs

  async createDoc(title: string, text: string): Promise<{ id: string; url: string }> {
    const doc = await this.json<{ documentId: string }>(DOCS, { method: "POST", body: JSON.stringify({ title }) });
    if (text) await this.appendText(doc.documentId, text);
    return { id: doc.documentId, url: `https://docs.google.com/document/d/${doc.documentId}/edit` };
  }

  /** Adds text at the end of a document. */
  async appendText(id: string, text: string): Promise<void> {
    await this.request(`${DOCS}/${encodeURIComponent(id)}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests: [{ insertText: { endOfSegmentLocation: {}, text: text.endsWith("\n") ? text : `${text}\n` } }] }),
    });
  }
}
