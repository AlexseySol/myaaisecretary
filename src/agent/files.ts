import type { Env } from "../env";
import { parseDocument, textPart } from "../lib/parse";
import { chatText, pdfPart } from "../llm/openrouter";

/**
 * A file as text for an agent's tool (a Gmail attachment, a Drive file): Word, Excel, PowerPoint, CSV and text are read
 * in code; a PDF goes to the model with the question (OpenRouter extracts its text), and the answer comes back.
 */
export async function fileText(env: Env, bytes: Uint8Array, name: string, mime = "", question = "", part = 1): Promise<string> {
  const parsed = parseDocument(bytes, name, mime);
  // A long file comes part by part: nothing is lost, and one answer stays small.
  if (parsed.kind === "text") return parsed.text ? textPart(parsed.text, part) : "(файл порожній)";
  if (parsed.kind === "pdf") {
    const ask = question || "Перекажи зміст цього документа: про що він, сторони, суми, дати, строки, що від власника чекають.";
    return chatText(env, env.AGENT_MODEL, [
      { role: "user", content: [{ type: "text", text: `${ask}\nВідповідай мовою питання, лише за документом, нічого не вигадуй.` }, pdfPart(name, parsed.base64)] },
    ]);
  }
  return `Не вмію читати файл «${name}»${mime ? ` (${mime})` : ""}. Читаю PDF, Word, Excel, PowerPoint, CSV і текст.`;
}
