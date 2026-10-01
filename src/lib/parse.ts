import { unzip } from "./unzip";

/**
 * Reads the files people send: Word (.docx), Excel (.xlsx), PowerPoint (.pptx), CSV and plain text — here, without
 * dependencies. A PDF is handed to the model as a file (OpenRouter extracts its text), so it comes back as `pdf`.
 */

export type Parsed = { kind: "text"; text: string } | { kind: "pdf"; base64: string } | { kind: "unknown" };

/** How much of a file's text goes to the model at once; the rest is read part by part (textPart). */
export const MAX_TEXT = 20_000;

/**
 * One part of a long text (1-based): nothing is cut off for good — the note at the end says how many parts there are,
 * and the agent asks for the next one with the tool's part parameter.
 */
export function textPart(text: string, part = 1): string {
  const parts = Math.max(1, Math.ceil(text.length / MAX_TEXT));
  const n = Math.min(Math.max(1, Math.floor(part) || 1), parts);
  const chunk = text.slice((n - 1) * MAX_TEXT, n * MAX_TEXT);
  return parts > 1 ? `${chunk}\n…(частина ${n} з ${parts}${n < parts ? `; далі — part=${n + 1}` : ""})` : chunk;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m),
  );
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);

function docx(bytes: Uint8Array): string {
  const xml = utf8(unzip(bytes, (n) => n === "word/document.xml").get("word/document.xml") ?? new Uint8Array());
  return decodeXml(
    xml
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<w:br\/>/g, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Column letters of a cell reference («C12» → 2). */
const column = (ref: string) => [...(/^[A-Z]+/.exec(ref)?.[0] ?? "A")].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

function xlsx(bytes: Uint8Array): string {
  const files = unzip(bytes, (n) => n === "xl/sharedStrings.xml" || n === "xl/workbook.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const shared = [...utf8(files.get("xl/sharedStrings.xml") ?? new Uint8Array()).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    decodeXml([...m[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")),
  );
  const names = [...utf8(files.get("xl/workbook.xml") ?? new Uint8Array()).matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => decodeXml(m[1]!));
  const sheets = [...files.keys()].filter((n) => n.startsWith("xl/worksheets/")).sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));
  return sheets
    .map((file, i) => {
      const rows = [...utf8(files.get(file)!).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((row) => {
        const cells: string[] = [];
        for (const c of row[1]!.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = c[1]!;
          const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? "";
          const type = /t="(\w+)"/.exec(attrs)?.[1];
          const inner = c[2] ?? "";
          const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";
          const value =
            type === "s" ? (shared[Number(v)] ?? "") : type === "inlineStr" ? decodeXml((/<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? "")) : decodeXml(v);
          cells[ref ? column(ref) : cells.length] = value;
        }
        return Array.from(cells, (x) => x ?? "").join(" | ");
      });
      return `## ${names[i] ?? `Аркуш ${i + 1}`}\n${rows.filter((r) => r.replace(/[\s|]/g, "")).join("\n")}`;
    })
    .join("\n\n");
}

function pptx(bytes: Uint8Array): string {
  const files = unzip(bytes, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  return [...files.keys()]
    .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]))
    .map((n, i) => `## Слайд ${i + 1}\n${[...utf8(files.get(n)!).matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => decodeXml(t[1]!)).join(" ")}`)
    .join("\n\n");
}

export function parseDocument(bytes: Uint8Array, name: string, mime = ""): Parsed {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  try {
    if (ext === "pdf" || mime === "application/pdf") return { kind: "pdf", base64: Buffer.from(bytes).toString("base64") };
    if (ext === "docx" || mime.includes("wordprocessingml")) return { kind: "text", text: docx(bytes) };
    if (ext === "xlsx" || mime.includes("spreadsheetml")) return { kind: "text", text: xlsx(bytes) };
    if (ext === "pptx" || mime.includes("presentationml")) return { kind: "text", text: pptx(bytes) };
    if (["txt", "csv", "tsv", "md", "json", "xml", "log"].includes(ext) || mime.startsWith("text/")) return { kind: "text", text: utf8(bytes) };
    if (ext === "html" || ext === "htm") return { kind: "text", text: decodeXml(utf8(bytes).replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")) };
  } catch {
    // A broken file reads as unknown.
  }
  return { kind: "unknown" };
}
