import { loadDirectory } from "../bot/contacts";
import { loadOwner } from "../bot/owner";
import { bitrixConfigured, type Env } from "../env";
import { connectLink, hasFreeBusyScope, hasGmailScope, hasGoogleAuth } from "../google/oauth";
import type { ContentPart } from "../llm/openrouter";
import { HttpError } from "../lib/http";
import { esc, Telegram } from "../telegram/api";
import type { InlineKeyboard } from "../telegram/types";
import { calendarTools } from "./calendarTools";
import { gmailTools } from "./gmailTools";
import { toTelegramHtml } from "./html";
import { conversationBlock, conversationHistory, factsBlock, lastBotTurn, loadMemory, memoryTools, pendingAgent, rememberTurn, saveMemory } from "./memory";
import { bitrixPrompt, calendarPrompt, docsPrompt, gmailPrompt, notesPrompt, supervisorPrompt } from "./prompts";
import { notesTools } from "./notesTools";
import { docsTools } from "./docsTools";
import { hasWorkspaceScope } from "../google/workspace";
import { bitrixTools } from "./bitrixTools";
import { routeByKeywords, routeFollowUp, routeWithDecision } from "./route";
import { ModelError, runAgent, str, type Tool } from "./runner";

/**
 * The n8n "AI Agent ALL" flow: Normalize Input → Build Agent Context → 🧠 Supervisor (with the Calendar Agent and
 * the Gmail Agent as tools) → Parse Agent Output → reply in Telegram (and, for a button, answer it and remove the
 * buttons).
 */
export interface AgentInput {
  chatId: number;
  inputType: "text" | "voice" | "photo" | "document" | "callback" | "forward";
  text: string;
  /** Text of the bot message the owner replied to, or of the message with the pressed button. */
  replyText?: string | null;
  /** What that bot message is about ("eventId: …" / "messageId: …"), read from its hidden data. */
  replyRef?: string | null;
  callbackData?: string | null;
  callbackId?: string | null;
  /** Message with the pressed button (its buttons are removed afterwards). */
  callbackMessageId?: number | null;
  /** The buttons under that message: only the pressed invitation's row goes (the morning report has several). */
  callbackKeyboard?: InlineKeyboard | null;
  /** Photos / image documents, for the model to see. */
  images?: ContentPart[];
}

/** n8n "Build Agent Context": reply context before the text, the session block after it. */
export function buildChatInput(input: AgentInput): string {
  let chatInput = "";
  if (input.replyText || input.replyRef) {
    const ref = input.replyRef ? `\n[${input.replyRef}]` : "";
    chatInput += `---REPLY_TO_BOT_MESSAGE---\n${(input.replyText ?? "").substring(0, 500)}${ref}\n---END_REPLY---\n\n`;
  }
  chatInput += `USER: ${input.text}`;
  chatInput += `\n\n---SESSION---\ncurrentFlow: idle\ninputType: ${input.inputType}\nchatId: ${input.chatId}`;
  if (input.callbackData) chatInput += `\ncallbackData: ${input.callbackData}`;
  if (input.images?.length) chatInput += `\nhasMedia: true`;
  return chatInput;
}

function withImages(text: string, images: ContentPart[] | undefined): string | ContentPart[] {
  return images?.length ? [{ type: "text", text }, ...images] : text;
}

type AgentName = "calendar_agent" | "gmail_agent" | "bitrix_agent" | "docs_agent" | "notes_agent";

/** One sub-agent (n8n "Calendar Agent" / "Gmail Agent" sub-workflow) on the user's message, with its own memory. */
/** One request's run: the model for it, and whether a tool already changed something (then it is never retried). */
export interface RunContext {
  model: string;
  wrote: boolean;
  /** The agent that answered (kept with the answer: a question it asked gets the owner's reply). */
  agent?: AgentName;
}

/** Tools that only read; any other tool call changes the calendar or the mailbox. */
const READ_ONLY = /^(get_|check_free_busy|msg_get|thread_get|draft_get|label_get|attachment_read|find_|list_tasks|task_stats|remember_fact|forget_fact|drive_search|drive_read|sheets_read|note_search)/;

function tracking(ctx: RunContext) {
  return (name: string) => {
    if (!READ_ONLY.test(name)) ctx.wrote = true;
  };
}

/**
 * Which model serves a request: pictures → VISION_MODEL (sees images), voice → LLM_MODEL (spoken requests are
 * messy), plain text → AGENT_MODEL (cheap). LLM_MODEL is also the second try when the cheap one fails.
 */
export function modelFor(env: Env, input: AgentInput): string {
  if (input.images?.length) return env.VISION_MODEL;
  if (input.inputType === "voice") return env.LLM_MODEL;
  return env.AGENT_MODEL;
}

async function runSubAgent(env: Env, name: AgentName, userMessage: string, input: AgentInput, now: Date, ctx: RunContext): Promise<string> {
  ctx.agent = name;
  if (name === "docs_agent") {
    // A file sent in the chat is read without Google; Drive, Sheets and Docs need the permission.
    const drive = (await hasGoogleAuth(env)) && (await hasWorkspaceScope(env).catch(() => false));
    const noDrive = drive
      ? ""
      : `\n\n## ДОСТУПУ ДО GOOGLE ДИСКА НЕМАЄ\nПрисланий файл (його вміст — у повідомленні) читай і відповідай. Якщо ж просять щось на Диску, в Таблицях чи Документах — скажи: «Щоб я працював з Google Диском, перепідключіть Google з усіма галочками: ${await connectLink(env)}».`;
    return runAgent(env, {
      model: ctx.model,
      onTool: tracking(ctx),
      system: docsPrompt(await loadOwner(env), now) + noDrive + factsBlock() + conversationBlock(),
      history: conversationHistory(),
      input: withImages(userMessage, input.images),
      tools: [...(drive ? docsTools(env) : []), ...memoryTools],
      maxIterations: 12,
    });
  }
  if (name === "notes_agent") {
    if (!(await hasGoogleAuth(env))) return `Нотатки зберігаються на вашому Google Диску — спершу підключіть Google: ${await connectLink(env)}`;
    if (!(await hasWorkspaceScope(env).catch(() => false))) {
      return `Нотатки зберігаються на вашому Google Диску, а доступу до нього немає. Перепідключіть Google з усіма галочками: ${await connectLink(env)}`;
    }
    return runAgent(env, {
      model: ctx.model,
      onTool: tracking(ctx),
      system: notesPrompt(await loadOwner(env), now) + factsBlock() + conversationBlock(),
      history: conversationHistory(),
      input: withImages(userMessage, input.images),
      tools: [...notesTools(env), ...memoryTools],
      maxIterations: 10,
    });
  }
  if (name === "bitrix_agent") {
    if (!bitrixConfigured(env)) return "Bitrix24 ще не підключено. Підключіть його в /settings → «🔗 Підключити Bitrix24».";
    const memoryKey = `${name}:${input.chatId}`;
    const answer = await runAgent(env, {
      model: ctx.model,
      onTool: tracking(ctx),
      system: bitrixPrompt(await loadOwner(env), now) + factsBlock() + conversationBlock(),
      history: conversationHistory(),
      input: withImages(userMessage, input.images),
      tools: [...bitrixTools(env), ...memoryTools],
      maxIterations: 12,
    });
    return answer;
  }
  if (!(await hasGoogleAuth(env))) return `Google не підключено. Нехай власник натисне /start → «Підключити Google»: ${await connectLink(env)}`;
  if (name === "gmail_agent" && !(await hasGmailScope(env))) {
    return `Немає доступу до Gmail. Нехай власник перепідключить Google (/settings) і поставить галочки для пошти: ${await connectLink(env)}`;
  }
  const memoryKey = `${name}:${input.chatId}`;
  const owner = await loadOwner(env);
  const answer =
    name === "calendar_agent"
      ? await runAgent(env, {
          model: ctx.model,
          onTool: tracking(ctx),
          system: calendarPrompt(owner, await loadDirectory(env), now) + factsBlock() + conversationBlock(),
          history: conversationHistory(),
          input: withImages(userMessage, input.images),
          tools: [...calendarTools(env, owner.email, { currentText: input.text, freeBusyScope: await hasFreeBusyScope(env) }), ...memoryTools],
          maxIterations: 10,
        })
      : await runAgent(env, {
          model: ctx.model,
          onTool: tracking(ctx),
          system: gmailPrompt(await loadDirectory(env).catch(() => [])) + factsBlock() + conversationBlock(),
          history: conversationHistory(),
          input: withImages(userMessage, input.images),
          tools: [...gmailTools(env), ...memoryTools],
          maxIterations: 10,
        });
  return answer;
}

/** n8n sub-workflows cut the session block off and keep the user's message (with the reply context). */
function userMessageOf(chatInput: string): string {
  return chatInput.split("\n\n---SESSION---")[0]!.replace("USER: ", "").trim();
}

export async function runSupervisor(env: Env, input: AgentInput, ctx: RunContext, now = new Date()): Promise<string> {
  const chatInput = buildChatInput(input);
  const key = String(input.chatId);

  // Plain code first: an obvious calendar or mail request goes straight to its agent (the Supervisor would only
  // pass it on and repeat the answer — two model calls for nothing).
  // The owner answering the bot's own question («Яка назва?» → «ТЕСТ») goes back to the agent that asked, unless it is
  // clearly a new request of another kind.
  const bitrix = bitrixConfigured(env);
  const waiting = input.replyRef || input.inputType === "callback" ? null : (pendingAgent() as AgentName | null);
  // 1. A reply to the bot's own notice names its subject exactly: plain code.
  let direct: AgentName | null = input.replyRef ? (routeByKeywords(input, bitrix) as AgentName | null) : null;
  let decided = !!direct;
  // 2. The decision model (Jev) picks the agent, with the conversation in view (pictures go to the Supervisor, which sees them).
  if (!decided && input.inputType !== "callback" && !input.images?.length) {
    const last = lastBotTurn();
    const pick = await routeWithDecision(env, input, { lastBot: last?.text, lastAgent: last?.agent, waiting: !!waiting }, bitrix);
    if (pick) {
      decided = true;
      direct = pick.route === "several" || pick.route === "chat" ? null : (pick.route as AgentName);
      console.log("route:", pick.route, pick.confidence.toFixed(2));
    }
  }
  // 3. Without it (off, failed, unsure): the keyword table and the follow-up rule, as before.
  if (!decided) direct = waiting ? (routeFollowUp(input, waiting, bitrix) as AgentName | null) : (routeByKeywords(input, bitrix) as AgentName | null);
  if (direct) {
    const output = await runSubAgent(env, direct, userMessageOf(chatInput), input, now, ctx);
    return output;
  }

  const subAgent = (name: AgentName, description: string): Tool => ({
    spec: {
      name,
      description,
      parameters: {
        type: "object",
        properties: { prompt: { type: "string", description: "The user's full request: user message + reply context + session + callback, unchanged." } },
        required: ["prompt"],
      },
    },
    async run(args) {
      return runSubAgent(env, name, userMessageOf(str(args, "prompt") || chatInput), input, now, ctx);
    },
  });

  const output = await runAgent(env, {
    model: ctx.model,
    system: supervisorPrompt(bitrixConfigured(env)) + factsBlock() + conversationBlock(),
    history: conversationHistory(),
    input: withImages(chatInput, input.images),
    tools: [
      subAgent(
        "calendar_agent",
        "Calendar Agent — manages Google Calendar: create/update/delete events, check schedule, RSVP, reschedule, manage attendees. Supports Google Meet and Zoom. Call this tool for any calendar-related requests.",
      ),
      subAgent("gmail_agent", "Gmail Agent — search, read, send, reply, delete, label emails, read attachments. Call with the user's full request about email."),
      subAgent(
        "docs_agent",
        "Docs Agent — Google Drive, Sheets and Docs, and files (PDF, Word, Excel): find, read, summarise, create, add rows or text, move, share. Never deletes.",
      ),
      subAgent(
        "notes_agent",
        "Notes Agent — the owner's own notes, ideas, personal to-dos and personal reminders («запиши…», «нагадай мені о…», «що я записував…»): add, find, change, mark done, archive. Not meetings.",
      ),
      ...memoryTools,
      ...(bitrixConfigured(env)
        ? [
            subAgent(
              "bitrix_agent",
              "Bitrix24 Task Agent — the owner's tasks: list, read, analyse (incl. status from comments), add comments, create tasks with people. Cannot close or change tasks.",
            ),
          ]
        : []),
    ],
    maxIterations: 15,
    temperature: 0.2,
  });
  return output;
}

/**
 * ✅ Прийняти / ❌ Відхилити under an invitation: the n8n Calendar Agent's rule ("accept:{eventId} → RSVP tool") done
 * in code — same tool, same answer, no model call.
 */
async function answerInvitation(env: Env, accept: boolean, eventId: string): Promise<{ answer: string; note: string }> {
  if (!(await hasGoogleAuth(env))) return { answer: `Google не підключено: ${await connectLink(env)}`, note: "" };
  const owner = await loadOwner(env);
  const tools = calendarTools(env, owner.email);
  await tools.find((t) => t.spec.name === "rsvp_event")!.run({ eventId, responseStatus: accept ? "accepted" : "declined" });
  // Who and what, for the answer and for the conversation log (so «напиши йому» knows who «він» is).
  const ev = (await tools.find((t) => t.spec.name === "get_event")!.run({ eventId }).catch(() => ({}))) as {
    summary?: string;
    organizer?: { email?: string; displayName?: string };
  };
  const title = ev.summary ? ` «${esc(ev.summary)}»` : "";
  const org = ev.organizer?.email ? `${ev.organizer.displayName ? `${ev.organizer.displayName} ` : ""}<${ev.organizer.email}>` : "";
  return {
    answer: `${accept ? "✅ Зустріч" : "❌ Зустріч"}${title} ${accept ? "підтверджена" : "відхилена"}!${org ? `\n👤 Організатор: ${esc(org)}` : ""}`,
    note: `[Натиснув «${accept ? "Прийняти" : "Відхилити"}» під запрошенням${ev.summary ? ` «${ev.summary}»` : ""}${org ? ` від ${org}` : ""} (eventId: ${eventId})]`,
  };
}

/**
 * Runs the request on its model; if that model fails before changing anything, the same request goes to the strong
 * LLM_MODEL. After a change (an event created, an email sent) it is never repeated — that could duplicate it.
 */
/**
 * An answer with no real words («😊», «✅✅✅ Т Т»): what a cheap model sometimes gives when it did not understand.
 * It is never sent as is.
 */
export function isJunk(text: string): boolean {
  const plain = text.replace(/<[^>]+>/g, " ");
  return !/\p{L}{2,}/u.test(plain);
}

const NOT_UNDERSTOOD = "Не зрозумів вас. Напишіть, будь ласка, трохи докладніше, що зробити.";

export async function runWithFallback(env: Env, input: AgentInput): Promise<{ text: string; agent?: AgentName }> {
  const ctx: RunContext = { model: modelFor(env, input), wrote: false };
  const retry = async (why: string) => {
    console.warn(`agent: ${why}; retrying on ${env.LLM_MODEL}`);
    const again: RunContext = { model: env.LLM_MODEL, wrote: false };
    const text = await runSupervisor(env, input, again);
    return { text: isJunk(text) ? NOT_UNDERSTOOD : text, agent: again.agent };
  };
  let text: string;
  try {
    text = await runSupervisor(env, input, ctx);
  } catch (err) {
    if (!(err instanceof ModelError) || ctx.wrote || ctx.model === env.LLM_MODEL) throw err;
    return retry(err.message);
  }
  if (!isJunk(text)) return { text, agent: ctx.agent };
  // A junk answer after a change (a task created) must not repeat the change: say it plainly instead.
  if (ctx.wrote) return { text: "✅ Готово.", agent: ctx.agent };
  if (ctx.model === env.LLM_MODEL) return { text: NOT_UNDERSTOOD, agent: ctx.agent };
  return retry(`junk answer «${text.slice(0, 40)}»`);
}

/** The buttons left after answering one invitation: every row about other events stays. */
function remainingRows(keyboard: InlineKeyboard | null | undefined, eventId: string): InlineKeyboard {
  return (keyboard ?? []).filter((row) => !row.some((b) => b.callback_data === `accept:${eventId}` || b.callback_data === `decline:${eventId}`));
}

/** The whole flow for one update: run the agents, reply, and settle a pressed button. */
export async function handleWithAgents(env: Env, input: AgentInput): Promise<void> {
  const tg = new Telegram(env);
  const rsvp = /^(accept|decline):(.+)$/.exec(input.callbackData ?? "");
  await loadMemory(env);
  let output: string;
  if (rsvp) {
    const done = await answerInvitation(env, rsvp[1] === "accept", rsvp[2]!);
    output = done.answer;
    await rememberTurn(env, done.note, output, Date.now(), "calendar_agent");
  } else {
    const result = await runWithFallback(env, input);
    output = result.text;
    const about = input.replyText ? ` (у відповідь на: «${input.replyText.replace(/\s+/g, " ").slice(0, 120)}»)` : "";
    await rememberTurn(env, `${input.text}${about}`, output, Date.now(), result.agent);
  }
  const html = toTelegramHtml(output);
  await tg.send(input.chatId, html).catch(async (err) => {
    // Telegram rejected the markup (e.g. a broken link): the same answer as plain text.
    if (!(err instanceof HttpError && err.status === 400)) throw err;
    const plain = html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    await tg.send(input.chatId, esc(plain));
  });
  // Memory goes back to Drive after the owner already has the answer.
  await saveMemory(env);
  if (input.callbackId) {
    await tg.call("answerCallbackQuery", { callback_query_id: input.callbackId, text: "✅" }).catch(() => undefined);
    if (input.callbackMessageId) {
      await tg
        .call("editMessageReplyMarkup", {
          chat_id: input.chatId,
          message_id: input.callbackMessageId,
          reply_markup: { inline_keyboard: rsvp ? remainingRows(input.callbackKeyboard, rsvp[2]!) : [] },
        })
        .catch(() => undefined);
    }
  }
}
