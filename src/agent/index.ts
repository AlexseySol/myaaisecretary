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
import { bitrixPrompt, calendarPrompt, DATA_RULE, docsPrompt, gmailPrompt, notesPrompt, supervisorPrompt } from "./prompts";
import { notesTools } from "./notesTools";
import { peopleTools } from "./peopleTools";
import { docsTools } from "./docsTools";
import { hasWorkspaceScope } from "../google/workspace";
import { bitrixTools } from "./bitrixTools";
import { routeByKeywords, routeFollowUp, routeWithDecision } from "./route";
import { ModelError, OutOfTime, runAgent, str, type Tool } from "./runner";
import { Progress } from "./progress";
import { cutText } from "../lib/text";
import { type Continuation, continuationText, CUT_MS, handOff, MAX_HOPS, RETRY_UNTIL_MS, STEP_UNTIL_MS } from "./continue";

/**
 * The n8n "AI Agent ALL" flow: Normalize Input → Build Agent Context → 🧠 Supervisor (with the Calendar Agent and
 * the Gmail Agent as tools) → Parse Agent Output → reply in Telegram (and, for a button, answer it and remove the
 * buttons).
 */
export interface AgentInput {
  chatId: number;
  /** The owner's (last) message: the answer is a reply to it. */
  messageId?: number;
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
  /** No new model call after this (ms); a call still running at `hardDeadline` is cut off — the work goes on elsewhere. */
  deadline?: number;
  hardDeadline?: number;
  /** What the tools did in this request, for a continuation in a fresh invocation. */
  steps?: Step[];
  /** The live mini-log in the chat. */
  progress?: Progress;
  /** The owner just said «так» to the bot's preview: actions that change things may run (NEEDS_YES). */
  approved?: boolean;
  /** That preview's text: a message to someone goes only where the preview said (bitrixTools). */
  preview?: string;
}

/** One tool call done: which agent, which tool, short arguments and result. */
export interface Step {
  agent: string;
  tool: string;
  args: string;
  result: string;
}

const short = (v: unknown, n: number) => {
  const text = typeof v === "string" ? v : JSON.stringify(v ?? null);
  return cutText(text, n);
};

/** The time limits and the step log for one agent's run. */
function limits(ctx: RunContext, agent: string) {
  return {
    deadline: ctx.deadline,
    hardDeadline: ctx.hardDeadline,
    onBegin(tool: string) {
      ctx.progress?.step(tool);
    },
    onStep(tool: string, args: Record<string, unknown>, result: unknown) {
      // The sub-agents' calls are logged by the sub-agents themselves.
      if (tool.endsWith("_agent")) return;
      (ctx.steps ??= []).push({ agent, tool, args: short(args, 400), result: short(result, 600) });
    },
  };
}

/**
 * Actions that change something or reach other people (a meeting, an email, a task, a file): done ONLY when the owner
 * just answered «так» to the bot's preview (a message that starts with 📋). The model cannot skip it — the tool refuses
 * and tells it to show the preview first. Only reading needs none — and the bot's own chat memory (remember_fact), which
 * changes nothing of the owner's; a button the owner presses (✅ / ❌ under an invitation, under a reminder) is itself
 * the confirmation.
 */
export const NEEDS_YES = new Set([
  "create_event_google_meet",
  "create_event_zoom_link",
  "create_zoom_meeting",
  "update_event_fields",
  "reschedule_event",
  "manage_event_attendees",
  "delete_event",
  "msg_send",
  "msg_reply",
  "thread_reply",
  "msg_trash",
  "thread_trash",
  "draft_delete",
  "label_delete",
  "add_comment",
  "send_chat_message",
  "send_direct_message",
  "create_task",
  "sheets_append",
  "sheets_update",
  "docs_append",
  "docs_create",
  "sheets_create",
  "drive_create_folder",
  "drive_move",
  "drive_share",
  // Everything else that changes the owner's things: an answer to an invitation typed in words (the ✅ / ❌ buttons are
  // the owner's own press), drafts, labels, read marks, a restored email, notes.
  "rsvp_event",
  "draft_create",
  "label_create",
  "msg_add_label",
  "msg_remove_label",
  "msg_mark_read",
  "msg_mark_unread",
  "thread_untrash",
  "note_add",
  "note_update",
  "note_archive",
]);

/** The preview's first sign; the agents start every preview with it. */
export const PREVIEW_MARK = "📋";

/** Under a preview: ✅ is the owner's «так» (goes to the agents as that), ✏️ asks what to change. No other buttons. */
export const PREVIEW_BUTTONS: InlineKeyboard = [
  [
    { text: "✅ Так", callback_data: "ok:yes" },
    { text: "✏️ Змінити", callback_data: "ok:edit" },
  ],
];

/** «(так / змінити)», «(да/нет)» — the answers spelled out in text; under a preview the buttons say it. */
const ANSWER_HINT = /[ \t]*\((?:так|да|yes)\s*\/\s*[^()\n]{1,25}\)/gi;

/** A preview shows its choices only as buttons, never as text. */
export function withoutAnswerHint(html: string): string {
  return html.replace(ANSWER_HINT, "");
}

/** An answer that is a preview waiting for «так». */
export function isPreview(html: string): boolean {
  return html.replace(/<[^>]+>/g, "").trimStart().startsWith(PREVIEW_MARK);
}

const YES = /^(так|да|ок|ok|окей|okay|yes|yep|ага|угу|підтверджую|подтверждаю|давай|вірно|верно|правильно|згоден|згодна|согласен|согласна|все вірно|все верно|\+|👍|✅)(?=$|[\s,.!)])/i;
/** «Ставь», «створюй», «надсилай» mean yes only as the whole answer — «постав зустріч з …» is a new request. */
const DO_IT = /^(ставь|став|постав|ставити|ставим|створюй|создавай|створи|создай|надсилай|надішли|відправляй|отправляй|відправ|отправь|додай|добавь)$/i;

/** The owner's message is a plain «yes» (not «так, але о 15» — that is a change). */
export function isYes(text: string): boolean {
  const t = text.split("\n\n[ПРОДОВЖЕННЯ")[0]!.trim().toLowerCase().replace(/[.!]+$/, "");
  if (t.length > 40 || /(але|однак|но |только|тільки|only|змін|измен|інш|друг|не так|замість|вместо|\d)/.test(t)) return false;
  // Only a short answer made of «yes» words: «так, постав зустріч з Олегом» is a new request, not a yes.
  const words = t.split(/[\s,]+/).filter(Boolean);
  return words.length <= 3 && words.every((w) => YES.test(w) || DO_IT.test(w) || /^(все|всё|будь|ласка|пожалуйста|please|можна|можно)$/.test(w));
}

/**
 * Whether this request may change things: the owner said «так» to a preview — the bot's last message in the chat memory,
 * or the preview the owner replied to / pressed ✅ under (Telegram brings its text along, whatever the memory holds).
 */
export function approved(text: string, lastBot: string | undefined, repliedTo?: string | null): boolean {
  return (!!lastBot?.includes(PREVIEW_MARK) || !!repliedTo?.includes(PREVIEW_MARK)) && isYes(text);
}

function guarded(tools: Tool[], yes: boolean): Tool[] {
  if (yes) return tools;
  return tools.map((t) =>
    NEEDS_YES.has(t.spec.name)
      ? {
          spec: t.spec,
          run: async () => ({
            error:
              `НЕ виконано: спершу покажи власнику превʼю — повідомлення, що починається з «${PREVIEW_MARK}», з усіма даними ` +
              "(хто, що, коли, кому — з email) — і закінчи коротким питанням «Підтверджуєте?» (варіанти відповіді не пиши — під превʼю самі зʼявляться кнопки ✅ Так / ✏️ Змінити). Виконаєш, коли власник відповість «так».",
          }),
        }
      : t,
  );
}

/** Tools that only read; any other tool call changes the calendar or the mailbox. */
const READ_ONLY = /^(get_|check_free_busy|msg_get|thread_get|draft_get|label_get|attachment_read|find_|list_tasks|task_stats|remember_fact|forget_fact|drive_search|drive_read|sheets_read|note_search)/;

function tracking(ctx: RunContext) {
  return (name: string) => {
    if (!READ_ONLY.test(name)) ctx.wrote = true;
  };
}

/**
 * Which model serves a request: pictures → VISION_MODEL (sees images), text and voice (already transcribed) →
 * AGENT_MODEL. LLM_MODEL is the second try when it fails, and takes a prompt too big for its cheap range (runner.ts).
 */
export function modelFor(env: Env, input: AgentInput): string {
  if (input.images?.length) return env.VISION_MODEL;
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
      ...limits(ctx, name),
      system: docsPrompt(await loadOwner(env), now) + noDrive + factsBlock() + conversationBlock() + DATA_RULE,
      history: conversationHistory(),
      input: withImages(userMessage, input.images),
      tools: guarded([...(drive ? docsTools(env) : []), ...memoryTools], ctx.approved === true),
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
      ...limits(ctx, name),
      system: notesPrompt(await loadOwner(env), now) + factsBlock() + conversationBlock() + DATA_RULE,
      history: conversationHistory(),
      input: withImages(userMessage, input.images),
      tools: guarded([...notesTools(env), ...memoryTools], ctx.approved === true),
      maxIterations: 10,
    });
  }
  if (name === "bitrix_agent") {
    if (!bitrixConfigured(env)) return "Bitrix24 ще не підключено. Підключіть його в /settings → «🔗 Підключити Bitrix24».";
    const memoryKey = `${name}:${input.chatId}`;
    const answer = await runAgent(env, {
      model: ctx.model,
      onTool: tracking(ctx),
      ...limits(ctx, name),
      system: bitrixPrompt(await loadOwner(env), now) + factsBlock() + conversationBlock() + DATA_RULE,
      history: conversationHistory(),
      input: withImages(userMessage, input.images),
      tools: guarded([...bitrixTools(env, ctx.preview), ...memoryTools], ctx.approved === true),
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
          ...limits(ctx, name),
      ...limits(ctx, name),
          system: calendarPrompt(owner, await loadDirectory(env), now) + factsBlock() + conversationBlock() + DATA_RULE,
          history: conversationHistory(),
          input: withImages(userMessage, input.images),
          tools: guarded([...calendarTools(env, owner.email, { currentText: input.text, freeBusyScope: await hasFreeBusyScope(env) }), ...peopleTools(env), ...memoryTools], ctx.approved === true),
          maxIterations: 10,
        })
      : await runAgent(env, {
          model: ctx.model,
          onTool: tracking(ctx),
          ...limits(ctx, name),
      ...limits(ctx, name),
          system: gmailPrompt(await loadDirectory(env).catch(() => []), now) + factsBlock() + conversationBlock() + DATA_RULE,
          history: conversationHistory(),
          input: withImages(userMessage, input.images),
          tools: guarded([...gmailTools(env), ...peopleTools(env), ...memoryTools], ctx.approved === true),
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
  // 2. The decision model (Clef-flash) picks the agent, with the conversation — and any picture — in view.
  if (!decided && input.inputType !== "callback") {
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
    ...limits(ctx, "supervisor"),
    system: supervisorPrompt(bitrixConfigured(env), now) + factsBlock() + conversationBlock() + DATA_RULE,
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

/** The request did not fit even in several invocations: what was done, and what to do. */
function notFinished(done: Step[]): string {
  const did = done.filter((d) => !/^(get_|check_|find_|msg_get|thread_get|list_|drive_search|drive_read|sheets_read|note_search|remember_fact)/.test(d.tool));
  return (
    "😔 Не встиг виконати запит повністю — він завеликий для одного разу." +
    (did.length ? `\n\nВже зроблено: ${[...new Set(did.map((d) => d.tool))].join(", ")}.` : "\n\nНічого не змінено.") +
    "\n\nРозбийте, будь ласка, на кілька коротших повідомлень — напр., спершу зустріч, потім лист."
  );
}

const NOT_UNDERSTOOD = "Не зрозумів вас. Напишіть, будь ласка, трохи докладніше, що зробити.";

export interface AgentResult {
  text: string;
  agent?: AgentName;
  /** Out of time: the request goes on in a fresh invocation with these steps done, on this model. */
  handoff?: { steps: Step[]; model: string };
}

export async function runWithFallback(
  env: Env,
  input: AgentInput,
  opts: { startedAt?: number; model?: string; progress?: Progress } = {},
): Promise<AgentResult> {
  const start = opts.startedAt ?? Date.now();
  const yes = approved(input.text, lastBotTurn()?.text, input.replyText);
  const preview = yes ? (input.replyText?.includes(PREVIEW_MARK) ? input.replyText : lastBotTurn()?.text) : undefined;
  const timed = (model: string): RunContext => ({
    approved: yes,
    preview,
    model,
    wrote: false,
    deadline: start + STEP_UNTIL_MS,
    hardDeadline: start + CUT_MS,
    steps: [],
    progress: opts.progress,
  });
  const ctx = timed(opts.model ?? modelFor(env, input));
  const later = (c: RunContext, model = c.model): AgentResult => ({ text: "", agent: c.agent, handoff: { steps: c.steps ?? [], model } });
  const retry = async (why: string): Promise<AgentResult> => {
    // Not enough time left for a whole second run here: the next invocation runs it on the strong model.
    if (Date.now() > start + RETRY_UNTIL_MS) return later(ctx, env.LLM_MODEL);
    console.warn(`agent: ${why}; retrying on ${env.LLM_MODEL}`);
    const again = timed(env.LLM_MODEL);
    try {
      const text = await runSupervisor(env, input, again);
      return { text: isJunk(text) ? NOT_UNDERSTOOD : text, agent: again.agent };
    } catch (err) {
      if (err instanceof OutOfTime) return later(again);
      throw err;
    }
  };
  let text: string;
  try {
    text = await runSupervisor(env, input, ctx);
  } catch (err) {
    if (err instanceof OutOfTime) return later(ctx);
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
export async function handleWithAgents(env: Env, input: AgentInput, opts: { startedAt?: number; cont?: Continuation } = {}): Promise<void> {
  const tg = new Telegram(env);
  const rsvp = /^(accept|decline):(.+)$/.exec(input.callbackData ?? "");
  await loadMemory(env);
  let output: string;
  let progress: Progress | null = null;
  if (rsvp) {
    const done = await answerInvitation(env, rsvp[1] === "accept", rsvp[2]!);
    output = done.answer;
    await rememberTurn(env, done.note, output, Date.now(), "calendar_agent");
  } else {
    const cont = opts.cont;
    const runInput = cont ? { ...input, text: continuationText(input.text, cont.done) } : input;
    progress = new Progress(env, input.chatId, cont?.progress?.id ?? null, cont?.progress?.lines ?? []);
    const result = await runWithFallback(env, runInput, { startedAt: opts.startedAt, model: cont?.model, progress });
    if (result.handoff) {
      // Out of this invocation's time: the request goes on in a fresh one, with what is done so far.
      await progress.pause();
      const next: Continuation = {
        hop: (cont?.hop ?? 0) + 1,
        done: [...(cont?.done ?? []), ...result.handoff.steps],
        model: result.handoff.model,
        progress: { id: progress.messageId, lines: progress.done },
      };
      if (next.hop <= MAX_HOPS && (await handOff(env, input, next))) {
        if (next.hop === 1 && !progress.messageId) await tg.send(input.chatId, "⏳ Запит великий — ще працюю, відповім трохи згодом.").catch(() => undefined);
        return;
      }
      result.text = notFinished(next.done);
    }
    output = result.text;
    const about = input.replyText ? ` (у відповідь на: «${input.replyText.replace(/\s+/g, " ").slice(0, 120)}»)` : "";
    await rememberTurn(env, `${input.text}${about}`, output, Date.now(), result.agent);
  }
  const formatted = toTelegramHtml(output);
  const preview = isPreview(formatted);
  // A preview waits for the owner: ✅ Так / ✏️ Змінити under it (✅ is the same as typing «так») — the choices only as
  // buttons, never spelled out in the text.
  const html = preview ? withoutAnswerHint(formatted) : formatted;
  const sendOpts = { ...(input.messageId ? { replyTo: input.messageId } : {}), ...(preview ? { keyboard: PREVIEW_BUTTONS } : {}) };
  await tg.send(input.chatId, html, sendOpts).catch(async (err) => {
    // Telegram rejected the markup (e.g. a broken link): the same answer as plain text.
    if (!(err instanceof HttpError && err.status === 400)) throw err;
    const plain = html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    await tg.send(input.chatId, esc(plain), sendOpts);
  });
  // The answer is here: the mini-log goes.
  await progress?.finish();
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
