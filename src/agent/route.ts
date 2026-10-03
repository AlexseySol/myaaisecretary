import type { Env } from "../env";
import { decide } from "./decide";
import type { AgentInput } from "./index";

/**
 * The Supervisor's routing table from the n8n prompt ("визнач агента за ключовими словами"), done in code: when a
 * request clearly belongs to one agent, it goes there without a model call. Anything unclear — both topics, small
 * talk, a forwarded chat without keywords — still goes to the Supervisor.
 */
const CALENDAR = [
  /зустр|мітинг|митинг|встреч|созвон|дзвін|звонок|розклад|расписан|календар|calendar|meeting|schedule/,
  /\bmeet\b|\bzoom\b|(^|\s)зум|гугл міт|google meet/,
  /перенес|скасу|отмен|відмін|rsvp/,
  /сьогодні|сегодня|завтра|післязавтра|послезавтра|понеділ|понедел|вівтор|вторник|серед|четвер|пʼятниц|п'ятниц|пятниц|субот|неділ|воскресен/,
  /вільн|свобод|зайнят|занят|подія|подію|події|событи/,
];
const MAIL = [
  /пошт|почт|лист|письм|e-?mail|\bmail|gmail|inbox|вхідн|входящ/,
  /чернет|черновик|draft|мітк|метк|label|спам|spam/,
  /напиши|відправ|отправ|надішли|пришли|відпиши|ответь на/,
];

const matches = (patterns: RegExp[], text: string) => patterns.some((p) => p.test(text));

export type Agent = "calendar_agent" | "gmail_agent" | "bitrix_agent" | "docs_agent";

/** Google Drive, Sheets, Docs and files. */
const DOCS = [/гугл ?диск|google ?drive|(^|\s)диск(у|і|а)?(?=$|[\s,.!?])|таблиц|sheets?(?=$|[\s,.!?])|гугл ?док|google ?docs?|документ|файл|папк|pdf|word|ексел|эксел|excel|xlsx|docx/];

const TASKS = [
  /задач|задан|таск|\btask|бітрікс|битрикс|bitrix|б24|b24|дедлайн|доручен|поручен|доручи|поручи|прострочен|просрочен/,
  /спостеріга|спостерега|наблюдател|співвиконав|соисполнит|постановник|виконавц|исполнител|чат задач|по задач/,
];

/**
 * The words that surely start a new request of that kind: a meeting, an email. Dates («післязавтра») and «напиши»
 * are not among them — they also come in the answer to the bot's question about a task.
 */
const SURE: Record<Agent, RegExp[]> = {
  calendar_agent: CALENDAR.slice(0, 3),
  gmail_agent: MAIL.slice(0, 2),
  bitrix_agent: TASKS,
  docs_agent: DOCS,
};

/**
 * Where the owner's answer goes while an agent waits for it (it asked a question): back to that agent, unless the
 * message is plainly a new request for another one.
 */
export function routeFollowUp(input: AgentInput, waiting: Agent, bitrix = false): Agent | null {
  const text = input.text.toLowerCase();
  const other = routeByKeywords(input, bitrix);
  // Several kinds at once («так, скасуй і напиши їм лист») — the Supervisor, which has every agent.
  if (!other && otherSure(waiting, text, bitrix)) return null;
  if (!other || other === waiting) return waiting;
  return matches(SURE[other], input.text.toLowerCase()) && !matches(SURE[waiting], input.text.toLowerCase()) ? other : waiting;
}

/** The text surely asks for another agent's kind of work too (an email while in the calendar, a meeting while in mail…). */
function otherSure(current: Agent, text: string, bitrix: boolean): boolean {
  return (Object.keys(SURE) as Agent[]).some((a) => a !== current && (a !== "bitrix_agent" || bitrix) && matches(SURE[a], text));
}

export function routeByKeywords(input: AgentInput, bitrix = false): Agent | null {
  // A reply to the bot's own notice names its subject exactly — unless it also asks for something of another kind
  // («скасуй і напиши учасникам лист»): then the Supervisor, which has every agent.
  const lower = input.text.toLowerCase();
  if (input.replyRef?.startsWith("eventId:")) return otherSure("calendar_agent", lower, bitrix) ? null : "calendar_agent";
  if (input.replyRef?.startsWith("messageId:")) return otherSure("gmail_agent", lower, bitrix) ? null : "gmail_agent";
  if (input.replyRef?.startsWith("taskId:")) return bitrix ? "bitrix_agent" : null;
  if (input.inputType === "forward" || input.images?.length) return null;
  const text = input.text.toLowerCase();
  // A task is often about a day ("задача на завтра") or a person to write to: task words decide first.
  if (bitrix && matches(TASKS, text)) return matches(MAIL.slice(0, 1), text) ? null : "bitrix_agent";
  const calendar = matches(CALENDAR, text);
  const mail = matches(MAIL, text);
  const docs = matches(DOCS, text);
  // Two topics at once («надішли Івану цей документ») — the Supervisor decides.
  if (Number(calendar) + Number(mail) + Number(docs) !== 1) return null;
  return calendar ? "calendar_agent" : mail ? "gmail_agent" : "docs_agent";
}

/** What the decision model may answer: one agent, several kinds at once, or plain conversation. */
export type RouteChoice = Agent | "several" | "chat";

/** Below this confidence the decision model's choice is not trusted: the usual routing decides. */
export const ROUTE_CONFIDENCE = 0.5;

/**
 * The agent for a message, chosen by the decision model (TypeSafe Jev) — with the conversation in view, so it never
 * fights the memory: the bot's latest answer, the agent that gave it and whether it waits for an answer go into the
 * state, and an answer to the bot's question goes back to that agent. "several" / "chat" → the Supervisor.
 * Null when the model is off, failed or unsure: the keyword table and the follow-up rule decide as before.
 */
export async function routeWithDecision(
  env: Env,
  input: AgentInput,
  conversation: { lastBot?: string; lastAgent?: string; waiting?: boolean },
  bitrix: boolean,
): Promise<{ route: RouteChoice; confidence: number } | null> {
  const criteria: Record<string, string> = {
    calendar_agent:
      "Google Calendar: create, move, cancel or show meetings and events, free or busy time, answer an invitation, the guests of a meeting, reminders before meetings",
    gmail_agent: "Email: check, find, read, write, reply, forward, send letters (also to a meeting's participants), drafts, labels, attachments of letters",
    docs_agent: "Google Drive, Sheets and Docs, and files: find, read, create, add rows or text, move, share; a PDF, Word or Excel file sent in the chat",
    ...(bitrix
      ? { bitrix_agent: "Bitrix24 tasks: the owner's or a colleague's tasks, deadlines, overdue, set a task to a person, comment a task, task analytics and reports" }
      : {}),
    several: "The message asks for work of two or more different kinds above at once (e.g. cancel a meeting AND write an email)",
    chat: "Greeting, thanks, small talk, a question about the bot itself, or anything not about calendar, email, files or tasks",
  };
  const state = {
    message: input.text.slice(0, 2000),
    message_kind: input.inputType === "forward" ? "forwarded messages" : input.inputType === "voice" ? "voice message (transcribed)" : "typed message",
    ...(input.replyText ? { reply_to_bot_message: input.replyText.slice(0, 500) } : {}),
    ...(conversation.lastBot ? { bot_last_message: conversation.lastBot.slice(0, 600) } : {}),
    ...(conversation.lastAgent ? { bot_last_message_by: conversation.lastAgent } : {}),
    bot_waits_for_answer: !!conversation.waiting,
  };
  const instructions =
    "Which assistant must handle the owner's latest message? If bot_waits_for_answer is true and the message is an answer to the bot's question " +
    "(a name, a time, an email, details, «так», «ні», a choice), choose the agent in bot_last_message_by. A new request of another kind goes to its own agent.";
  const d = await decide(env, state, instructions, criteria);
  if (!d || d.confidence < ROUTE_CONFIDENCE) return null;
  return { route: d.choice as RouteChoice, confidence: d.confidence };
}
