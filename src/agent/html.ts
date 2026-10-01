/**
 * The n8n "Parse Agent Output" node: turns a model answer into safe, tidy Telegram HTML.
 * - code fences around the whole answer out, a JSON {"response": …} unwrapped;
 * - Markdown the model slipped into (**bold**, *italic*, `code`, ```blocks```, # headings, - lists, [links](…)) → HTML;
 * - web HTML mapped to Telegram's (strong→b, em→i, del→s, h1–h6 → bold line, br/p/div → line breaks, li → «• »);
 * - only Telegram's tags kept, links only http(s)/tg/mailto, tags nested properly (a stray or crossed tag would make
 *   Telegram reject the whole message), every unclosed tag closed;
 * - «&», «<», «>» in the text escaped; at most one empty line in a row.
 * The length is not cut here: Telegram.send splits a long answer into several messages, keeping tags whole.
 */
const ALLOWED = new Set(["b", "i", "u", "s", "a", "code", "pre", "blockquote", "tg-spoiler"]);
const RENAME: Record<string, string> = { strong: "b", em: "i", ins: "u", del: "s", strike: "s", tt: "code", kbd: "code" };
const SAFE_HREF = /^(https?:\/\/|tg:\/\/|mailto:)/i;

/** Markdown leftovers → HTML (the prompts ask for HTML; models sometimes write Markdown anyway). */
function fromMarkdown(text: string): string {
  const blocks: string[] = [];
  // ```code blocks``` first, kept away from the rest.
  let out = text.replace(/```([a-zA-Z]*)\n?([\s\S]*?)```/g, (_, lang: string, code: string) => {
    // ```html … ``` is the answer itself wrapped by the model, not code to show.
    blocks.push(lang.toLowerCase() === "html" ? code.replace(/\n$/, "") : `<pre>${escapeText(code.replace(/\n$/, ""))}</pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  out = out
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/^\s*[-*•]\s+/gm, "• ")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<b>$1</b>")
    .replace(/(^|[\s(«"])\*([^*\n]+)\*(?=$|[\s).,!?:;»"])/gm, "$1<i>$2</i>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]\n]+)\]\(((?:https?|tg|mailto):[^)\s]+)\)/g, '<a href="$2">$1</a>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => blocks[Number(i)]!);
}

/** «&» that is not an entity, «<» and «>» → entities (text between tags only). */
function escapeText(text: string): string {
  return text
    .replace(/&(?!amp;|lt;|gt;|quot;|#\d+;|#x[0-9a-f]+;)/gi, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const attr = (tag: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);

export function toTelegramHtml(output: string): string {
  let response = output.trim();
  // The whole answer in a code fence (```html … ```): the fence goes, the content stays.
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(response);
  if (fenced) response = fenced[1]!;
  try {
    const match = response.match(/^\{[\s\S]*\}$/);
    if (match) {
      const parsed = JSON.parse(match[0]) as { response?: unknown };
      if (typeof parsed.response === "string") response = parsed.response;
    }
  } catch {
    /* not JSON */
  }
  response = fromMarkdown(response);

  // Walk tags and text: keep Telegram's tags, nested properly; the rest becomes text or line breaks.
  let html = "";
  const open: string[] = [];
  const closeTo = (tag: string) => {
    const at = open.lastIndexOf(tag);
    if (at < 0) return; // a closing tag nothing opened: dropped
    // Crossed tags (<b><i></b></i>): close the inner ones too, then reopen them.
    const inner = open.splice(at);
    for (const t of [...inner].reverse()) html += `</${t}>`;
    for (const t of inner.slice(1)) {
      html += `<${t}>`;
      open.push(t);
    }
  };
  const tokens = response.split(/(<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>)/);
  for (const token of tokens) {
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(token);
    if (!m) {
      html += escapeText(token);
      continue;
    }
    const closing = m[1] === "/";
    let tag = m[2]!.toLowerCase();
    tag = RENAME[tag] ?? tag;
    if (tag === "span" && /tg-spoiler/.test(token)) tag = "tg-spoiler";
    if (tag === "br") {
      html += "\n";
      continue;
    }
    if (/^h[1-6]$/.test(tag)) {
      if (closing) {
        closeTo("b");
        html += "\n";
      } else {
        html += "\n<b>";
        open.push("b");
      }
      continue;
    }
    if (tag === "p" || tag === "div" || tag === "tr" || tag === "ul" || tag === "ol") {
      if (closing) html += "\n";
      continue;
    }
    if (tag === "li") {
      if (!closing) html += "\n• ";
      continue;
    }
    if (!ALLOWED.has(tag)) continue;
    if (closing) {
      closeTo(tag);
      continue;
    }
    if (tag === "a") {
      const href = attr(token, "href");
      const url = (href?.[2] ?? href?.[3] ?? href?.[4] ?? "").trim();
      if (!SAFE_HREF.test(url)) continue; // no usable link: the text stays, the tag goes
      html += `<a href="${url.replace(/&(?!amp;)/g, "&amp;").replace(/"/g, "&quot;")}">`;
    } else if (tag === "pre" || tag === "code") {
      const lang = tag === "code" ? attr(token, "class")?.[2] : undefined;
      html += lang && /^language-[\w-]+$/.test(lang) ? `<code class="${lang}">` : `<${tag}>`;
    } else if (tag === "blockquote" && /\sexpandable\b/i.test(token)) {
      html += "<blockquote expandable>";
    } else {
      html += `<${tag}>`;
    }
    open.push(tag);
  }
  for (const t of open.reverse()) html += `</${t}>`;

  // Empty tags and runs of blank lines (from removed <p>, <div>…) go.
  html = html
    .replace(/<(b|i|u|s|code|tg-spoiler)><\/\1>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return html || "🙂";
}
