import { departmentNames, loadCompany } from "./structure";
import type { Env } from "../env";
import { buildXlsx, type Cell } from "../lib/xlsx";
import { chatJson } from "../llm/openrouter";
import { toKyivDate } from "../lib/time";
import { Bitrix, type BxComment, type BxTask, CLOSED, STATUS } from "./client";
import { isOverdue, kyivDateTime, projectName } from "./format";

/**
 * The Excel report of the owner's Bitrix24 tasks: every open task and those closed in the last 30 days, with the
 * project, Kanban stage, Bitrix24 status, the real state read from the task's comments (a short AI summary),
 * responsible, creator, dates and link; plus an analytics sheet. Read-only: nothing in Bitrix24 changes.
 */

/** Tasks summarised by AI per model call; the calls run in parallel. */
const AI_CHUNK = 12;
/** Tasks whose discussion is read per round (3 batch requests each). */
const COMMENT_ROUND = 150;
/**
 * Every task goes in (they come fast, 2 500 per Bitrix24 batch request). The whole report must fit Vercel's 60 seconds. Discussions are read, most important tasks first, until this point;
 * the AI summaries get until the next one; then the file is built and sent, whatever was not reached is marked so.
 */
const COMMENTS_UNTIL_MS = 25_000;
const AI_UNTIL_MS = 45_000;

/** What the Excel report can hold — the owner picks it in /bitrix → «📊 Excel-звіт». */
export const REPORT_SCOPES = {
  all: "🗂 Усе: відкриті й закриті за 30 днів",
  open: "📋 Лише відкриті",
  overdue: "🔥 Прострочені",
  week: "⏳ Дедлайн цього тижня",
  mine: "👤 Де я відповідальний",
  given: "📤 Які я поставив",
  closed: "✅ Закриті за 30 днів",
} as const;
export type ReportScope = keyof typeof REPORT_SCOPES;

export interface TaskReport {
  file: Uint8Array;
  filename: string;
  caption: string;
}

/** "Стан за коментарями" for many tasks: one short line each, from the latest comments. */
async function statusFromComments(env: Env, tasks: BxTask[], comments: Record<string, BxComment[]>, until = Infinity): Promise<Record<string, string>> {
  const withComments = tasks.filter((t) => comments[t.id]?.length);
  const timeLeft = until - Date.now();
  if (timeLeft <= 1000) return {};
  const chunks: BxTask[][] = [];
  for (let i = 0; i < withComments.length; i += AI_CHUNK) chunks.push(withComments.slice(i, i + AI_CHUNK));
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const input = chunk.map((t) => ({
        id: t.id,
        title: t.title,
        status: STATUS[String(t.status)] ?? t.status,
        deadline: kyivDateTime(t.deadline),
        comments: (comments[t.id] ?? []).slice(-8).map((c) => `${kyivDateTime(c.date)} ${c.authorName}: ${c.text.slice(0, 400)}`),
      }));
      try {
        const out = (await withDeadline(timeLeft, chatJson(env, env.AGENT_MODEL, [
          {
            role: "system",
            content:
              "Ти аналізуєш задачі Bitrix24. Для кожної задачі за її коментарями одним реченням (до 200 символів, українською) опиши " +
              "справжній стан: що зроблено, що заважає або чого чекають, наступний крок. Нічого не вигадуй: якщо з коментарів " +
              'незрозуміло — так і напиши. Відповідь — JSON-обʼєкт {"<id>": "<стан>"}.',
          },
          { role: "user", content: JSON.stringify(input) },
        ]))) as Record<string, unknown>;
        return Object.fromEntries(Object.entries(out ?? {}).map(([k, v]) => [String(k), String(v ?? "")]));
      } catch {
        return {};
      }
    }),
  );
  return Object.assign({}, ...results);
}

const OPEN = ["1", "2", "3", "4", "6"];

/** A promise that gives up after `ms` (the model's answer comes too late for this report). */
function withDeadline<T>(ms: number, work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("deadline")), ms);
    work.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

/** Most important first: overdue, then by the nearest deadline, then the rest; closed ones last. */
function byImportance(tasks: BxTask[], now: number): BxTask[] {
  const rank = (t: BxTask) => (CLOSED.has(String(t.status)) ? 3 : isOverdue(t, now) ? 0 : t.deadline ? 1 : 2);
  const due = (t: BxTask) => (t.deadline ? Date.parse(t.deadline) : Infinity);
  return [...tasks].sort((a, b) => rank(a) - rank(b) || due(a) - due(b));
}

/** Open, overdue and closed tasks per department of the responsible person. */
function byDepartment(tasks: BxTask[], department: (t: BxTask) => string, now: number): Cell[][] {
  const by = new Map<string, { active: number; overdue: number; closed: number }>();
  for (const t of tasks) {
    const d = department(t) || "Без відділу";
    const row = by.get(d) ?? { active: 0, overdue: 0, closed: 0 };
    if (CLOSED.has(String(t.status))) row.closed++;
    else {
      row.active++;
      if (isOverdue(t, now)) row.overdue++;
    }
    by.set(d, row);
  }
  return [...by].sort((a, b) => b[1].overdue - a[1].overdue || b[1].active - a[1].active).map(([d, r]): Cell[] => [d, r.active, r.overdue, r.closed]);
}

/** The report of the chosen tasks; null when there are none. */
export async function buildTaskReport(env: Env, now = Date.now(), scope: ReportScope = "all"): Promise<TaskReport | null> {
  const began = Date.now();
  const bx = new Bitrix(env);
  const me = await bx.me();
  const iso = (t: number) => new Date(t).toISOString();
  const openFilter: Record<string, unknown> =
    scope === "mine"
      ? { RESPONSIBLE_ID: me.id, REAL_STATUS: OPEN }
      : scope === "given"
        ? { CREATED_BY: me.id, REAL_STATUS: OPEN }
        : scope === "overdue"
          ? { MEMBER: me.id, REAL_STATUS: OPEN, "<DEADLINE": iso(now) }
          : scope === "week"
            ? { MEMBER: me.id, REAL_STATUS: OPEN, ">=DEADLINE": iso(now), "<DEADLINE": iso(now + 7 * 86_400_000) }
            : { MEMBER: me.id, REAL_STATUS: OPEN };
  const active = scope === "closed" ? [] : await bx.tasks(openFilter);
  const closed =
    scope === "all" || scope === "closed"
      ? await bx.tasks({ MEMBER: me.id, REAL_STATUS: ["5"], ">=CLOSED_DATE": iso(now - 30 * 86_400_000) }, Infinity, { CLOSED_DATE: "desc" })
      : [];
  const tasks = [...active, ...closed];
  if (!tasks.length) return null;
  // Discussions, most important tasks first, while there is time.
  const comments: Record<string, BxComment[]> = {};
  const ordered = byImportance(tasks, now);
  let read = 0;
  while (read < ordered.length && Date.now() - began < COMMENTS_UNTIL_MS) {
    Object.assign(comments, await bx.commentsOf(ordered.slice(read, read + COMMENT_ROUND).map((t) => t.id)));
    read += COMMENT_ROUND;
  }
  const stages: Record<string, Record<string, string>> = {};
  for (const g of [...new Set(tasks.filter((t) => t.stageId && t.stageId !== "0").map((t) => t.groupId ?? "0"))].slice(0, 20)) {
    stages[g] = await bx.stageNames(g);
  }
  const state = await statusFromComments(env, ordered.slice(0, read), comments, began + AI_UNTIL_MS);
  const analysed = Object.keys(state).length;
  const discussed = ordered.slice(0, read).filter((t) => comments[t.id]?.length).length;
  const name = async (t: BxTask, who: "responsible" | "creator") =>
    who === "responsible" ? t.responsible?.name || (await bx.personName(t.responsibleId)) : t.creator?.name || (await bx.personName(t.createdBy));

  // With the company structure: the responsible person's department, in a column and in the analytics.
  const company = await loadCompany(bx).catch(() => null);
  const department = (t: BxTask) => {
    const p = company?.people.find((x) => String(x.id) === String(t.responsibleId ?? t.responsible?.id));
    return company && p ? departmentNames(company, p).join(", ") : "";
  };
  const header: Cell[] = [
    "ID", "Задача", "Проєкт", "Стадія", "Статус у Bitrix24", "Стан за коментарями", "Відповідальний", ...(company ? ["Відділ"] : []), "Постановник",
    "Поставлено", "Дедлайн", "Прострочено", "Останній коментар", "Посилання",
  ];
  const rows: Cell[][] = [header];
  const highlight: number[] = [];
  for (const t of tasks) {
    const last = comments[t.id]?.at(-1);
    const overdue = isOverdue(t, now);
    if (overdue) highlight.push(rows.length);
    rows.push([
      Number(t.id),
      t.title,
      projectName(t),
      t.stageId && t.stageId !== "0" ? (stages[t.groupId ?? "0"]?.[String(t.stageId)] ?? "") : "",
      STATUS[String(t.status)] ?? String(t.status),
      state[t.id] || (!(t.id in comments) ? "Не встиг прочитати (задач багато)" : comments[t.id]!.length ? "" : "Коментарів немає"),
      await name(t, "responsible"),
      ...(company ? [department(t)] : []),
      await name(t, "creator"),
      kyivDateTime(t.createdDate, false),
      kyivDateTime(t.deadline),
      overdue ? "так" : "",
      last ? `${kyivDateTime(last.date)} · ${last.authorName}` : "",
      bx.taskUrl(t.id, me),
    ]);
  }

  // Analytics
  const openTasks = tasks.filter((t) => !CLOSED.has(String(t.status)));
  const overdueCount = openTasks.filter((t) => isOverdue(t, now)).length;
  const byPerson = new Map<string, { active: number; overdue: number; closed: number }>();
  for (const t of tasks) {
    const p = await name(t, "responsible");
    const row = byPerson.get(p) ?? { active: 0, overdue: 0, closed: 0 };
    if (CLOSED.has(String(t.status))) row.closed++;
    else {
      row.active++;
      if (isOverdue(t, now)) row.overdue++;
    }
    byPerson.set(p, row);
  }
  const byStatus = new Map<string, number>();
  for (const t of openTasks) byStatus.set(STATUS[String(t.status)] ?? String(t.status), (byStatus.get(STATUS[String(t.status)] ?? String(t.status)) ?? 0) + 1);
  const durations = closed
    .map((t) => (t.closedDate && t.createdDate ? (Date.parse(t.closedDate) - Date.parse(t.createdDate)) / 86_400_000 : NaN))
    .filter((d) => Number.isFinite(d) && d >= 0);
  const avg = durations.length ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10 : "";
  const analytics: Cell[][] = [
    ["Показник", "Значення", "", ""],
    ["Звіт сформовано", kyivDateTime(new Date(now).toISOString()), "", ""],
    ["Відкритих задач", openTasks.length, "", ""],
    ["З них прострочено", overdueCount, "", ""],
    ["Закрито за 30 днів", closed.length, "", ""],
    ["Середній час виконання, днів", avg, "", ""],
    ["", "", "", ""],
    ["Статус", "Задач", "", ""],
    ...[...byStatus].sort((a, b) => b[1] - a[1]).map(([s, n]): Cell[] => [s, n, "", ""]),
    ["", "", "", ""],
    ["Відповідальний", "Відкрито", "Прострочено", "Закрито за 30 днів"],
    ...[...byPerson].sort((a, b) => b[1].overdue - a[1].overdue || b[1].active - a[1].active).map(([p, r]): Cell[] => [p, r.active, r.overdue, r.closed]),
    ...(company ? [["", "", "", ""], ["Відділ", "Відкрито", "Прострочено", "Закрито за 30 днів"], ...byDepartment(tasks, department, now)] : []),
  ];

  const file = buildXlsx([
    { name: "Задачі", rows, widths: [8, 42, 20, 18, 18, 60, 22, 22, 12, 17, 12, 30, 40], highlight },
    { name: "Аналітика", rows: analytics, widths: [32, 14, 14, 20] },
  ]);
  return {
    file,
    filename: `zadachi-${scope === "all" ? "" : `${scope}-`}${toKyivDate(new Date(now))}.xlsx`,
    caption:
      `📊 <b>Звіт по задачах Bitrix24</b>\n${REPORT_SCOPES[scope]}\n\n` +
      `📋 Відкрито: <b>${openTasks.length}</b> · 🔥 прострочено: <b>${overdueCount}</b>\n` +
      `✅ Закрито за 30 днів: <b>${closed.length}</b>${avg !== "" ? ` · ⏱ в середньому ${avg} дн.` : ""}\n\n` +
      `<i>Прострочені задачі підсвічено червоним. «Стан за коментарями» — коротко з переписки в задачі.</i>` +
      (analysed < discussed || read < tasks.length
        ? `\n<i>Задач багато: стан за коментарями — для ${analysed} найважливіших (прострочені й найближчі дедлайни) з ${tasks.length}. Для решти — звузьте звіт (прострочені, цей тиждень, мої).</i>`
        : ""),
  };
}
