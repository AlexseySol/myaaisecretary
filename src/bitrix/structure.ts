import type { Env } from "../env";
import { esc, Telegram } from "../telegram/api";
import type { InlineKeyboard } from "../telegram/types";
import { Bitrix, type Department } from "./client";
import { fullName, type Person } from "./names";

/**
 * The company structure from Bitrix24 («Компанія → Структура компанії»), read only: departments, their heads and who
 * works where. /team and «🏢 Структура» in /bitrix show it with buttons (`bx:dep:<id>`, `bx:who:<id>`), no AI; the
 * Bitrix24 agent reads it with `company_structure`. Needs the optional «department» right of the webhook.
 */

export interface Company {
  departments: Department[];
  people: Person[];
}

/** The structure, or null when the webhook has no «Структура компанії» right. */
export async function loadCompany(bx: Bitrix): Promise<Company | null> {
  const [departments, people] = await Promise.all([bx.departments(), bx.people()]);
  return departments ? { departments, people } : null;
}

const bySort = (a: Department, b: Department) => a.sort - b.sort || a.name.localeCompare(b.name);

export function children(c: Company, id: number | undefined): Department[] {
  const known = new Set(c.departments.map((d) => d.id));
  // Top level: no parent, or a parent the list does not have.
  return c.departments.filter((d) => (id === undefined ? d.parent === undefined || !known.has(d.parent) : d.parent === id)).sort(bySort);
}

/** People of exactly this department (its head first). */
export function members(c: Company, d: Department): Person[] {
  return c.people
    .filter((p) => p.departments?.includes(d.id))
    .sort((a, b) => Number(b.id === d.headId) - Number(a.id === d.headId) || fullName(a).localeCompare(fullName(b)));
}

/** People of the department and everything under it. */
export function headcount(c: Company, d: Department): number {
  const ids = new Set<number>();
  const walk = (x: Department) => {
    for (const p of members(c, x)) ids.add(p.id);
    for (const k of children(c, x.id)) walk(k);
  };
  walk(d);
  return ids.size;
}

export const person = (c: Company, id: number | undefined) => (id ? c.people.find((p) => p.id === id) : undefined);

/** Whom the person reports to: the head of their department, or — for the head — of the department above. */
export function manager(c: Company, p: Person): Person | undefined {
  for (const depId of p.departments ?? []) {
    let d = c.departments.find((x) => x.id === depId);
    while (d) {
      if (d.headId && d.headId !== p.id) return person(c, d.headId);
      d = d.parent ? c.departments.find((x) => x.id === d!.parent) : undefined;
    }
  }
  return undefined;
}

export function departmentNames(c: Company, p: Person): string[] {
  return (p.departments ?? []).map((id) => c.departments.find((d) => d.id === id)?.name).filter((n): n is string => !!n);
}

// ---------------------------------------------------------------------------------------------------------------
// For the agent: compact data, no IDs it does not need.

/** The whole tree (or the departments matching `query`, with their people) for the Bitrix24 agent. */
export function structureForAgent(c: Company, query = ""): unknown {
  const brief = (p: Person | undefined) => (p ? { id: p.id, name: fullName(p), position: p.position ?? "" } : null);
  const q = query.trim().toLowerCase();
  if (q) {
    const found = c.departments.filter((d) => d.name.toLowerCase().includes(q));
    if (!found.length) return { departments: [], note: `Відділу «${query}» не знайдено. Ось усі відділи.`, all: c.departments.map((d) => d.name) };
    return {
      departments: found.map((d) => ({
        name: d.name,
        head: brief(person(c, d.headId)),
        parent: c.departments.find((x) => x.id === d.parent)?.name ?? null,
        subdepartments: children(c, d.id).map((k) => k.name),
        people: members(c, d).map(brief),
        totalWithSubdepartments: headcount(c, d),
      })),
    };
  }
  const node = (d: Department): unknown => ({
    name: d.name,
    head: person(c, d.headId) ? fullName(person(c, d.headId)!) : null,
    people: headcount(c, d),
    ...(children(c, d.id).length ? { subdepartments: children(c, d.id).map(node) } : {}),
  });
  return { company: children(c, undefined).map(node) };
}

// ---------------------------------------------------------------------------------------------------------------
// In the chat: /team and the buttons under it.

const NO_RIGHT =
  "🏢 <b>Структура компанії недоступна</b>\n\nДодайте вебхуку Bitrix24 право <b>«Структура компанії»</b> (department): " +
  "<b>Розробникам → Інше → Вхідний вебхук</b> → відкрийте вебхук → поставте галочку → <b>Зберегти</b>. Адреса лишається та сама — більше нічого робити не треба.";

const SHOWN_PEOPLE = 25;

function rows<T>(items: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** The text and buttons of one view: the whole company (id 0), a department, or a person (`who`). */
export function structureView(c: Company, id: number): { text: string; keyboard: InlineKeyboard } {
  if (!id) {
    const lines = ["🏢 <b>Структура компанії</b>", ""];
    for (const top of children(c, undefined)) {
      const head = person(c, top.headId);
      lines.push(`📂 <b>${esc(top.name)}</b>${head ? ` — 👤 ${esc(fullName(head))}` : ""} · ${headcount(c, top)}`);
      for (const sub of children(c, top.id)) {
        const h = person(c, sub.headId);
        lines.push(`      └ ${esc(sub.name)}${h ? ` — ${esc(fullName(h))}` : ""} · ${headcount(c, sub)}`);
      }
    }
    lines.push("", "<i>Натисніть відділ — покажу людей.</i>");
    const buttons = children(c, undefined).map((d) => ({ text: `📂 ${d.name}`, callback_data: `bx:dep:${d.id}` }));
    return { text: lines.join("\n"), keyboard: rows(buttons, 2) };
  }
  const d = c.departments.find((x) => x.id === id);
  if (!d) return structureView(c, 0);
  const head = person(c, d.headId);
  const people = members(c, d);
  const parent = c.departments.find((x) => x.id === d.parent);
  const lines = [`📂 <b>${esc(d.name)}</b>`];
  if (parent) lines.push(`<i>у складі «${esc(parent.name)}»</i>`);
  lines.push("");
  if (head) lines.push(`👤 <b>Керівник:</b> ${esc(fullName(head))}${head.position ? ` — ${esc(head.position)}` : ""}`);
  lines.push(`👥 <b>Людей:</b> ${headcount(c, d)}${children(c, d.id).length ? " (з підрозділами)" : ""}`);
  const rest = people.filter((p) => p.id !== d.headId);
  if (rest.length) {
    lines.push("");
    for (const p of rest.slice(0, SHOWN_PEOPLE)) lines.push(`• ${esc(fullName(p))}${p.position ? ` — <i>${esc(p.position)}</i>` : ""}`);
    if (rest.length > SHOWN_PEOPLE) lines.push(`… і ще ${rest.length - SHOWN_PEOPLE}`);
  }
  const subs = children(c, d.id);
  if (subs.length) lines.push("", `📁 <b>Підрозділи:</b> ${subs.map((s) => esc(s.name)).join(", ")}`);
  const keyboard: InlineKeyboard = [
    ...rows(subs.map((s) => ({ text: `📁 ${s.name}`, callback_data: `bx:dep:${s.id}` })), 2),
    ...rows(people.slice(0, 8).map((p) => ({ text: `👤 ${fullName(p)}`, callback_data: `bx:who:${p.id}` })), 2),
    [{ text: parent ? `⬅️ ${parent.name}` : "⬅️ Уся компанія", callback_data: `bx:dep:${parent?.id ?? 0}` }],
  ];
  return { text: lines.join("\n"), keyboard };
}

/** A person's card: department, position, manager, contacts; replying to it writes to them (through a preview). */
export function personView(c: Company, id: number): { text: string; keyboard: InlineKeyboard } {
  const p = person(c, id);
  if (!p) return structureView(c, 0);
  const deps = departmentNames(c, p);
  const boss = manager(c, p);
  const phone = p.profile?.PERSONAL_MOBILE ?? p.profile?.WORK_PHONE ?? p.profile?.PERSONAL_PHONE;
  const lines = [`👤 <b>${esc(fullName(p))}</b>`];
  if (p.position) lines.push(`💼 ${esc(p.position)}`);
  if (deps.length) lines.push(`📂 ${deps.map(esc).join(", ")}`);
  if (boss) lines.push(`⬆️ Керівник: ${esc(fullName(boss))}`);
  if (p.email) lines.push(`📧 ${esc(p.email)}`);
  if (phone) lines.push(`📞 ${esc(phone)}`);
  lines.push("", `<i>Щоб написати ${esc(p.name || fullName(p))} в особисті Bitrix24 — відповідайте на це повідомлення текстом, я покажу превʼю.</i>`);
  const back = p.departments?.[0];
  return {
    text: lines.join("\n"),
    keyboard: [
      [{ text: "📋 Задачі", callback_data: `bx:wt:${p.id}` }],
      [{ text: "⬅️ До відділу", callback_data: `bx:dep:${back ?? 0}` }],
    ],
  };
}

/** /team, «🏢 Структура» and the buttons: a new message, or the pressed one edited in place. */
export async function showStructure(env: Env, chatId: number, view: { dep?: number; who?: number } = {}, messageId?: number): Promise<void> {
  const tg = new Telegram(env);
  const company = await loadCompany(new Bitrix(env));
  if (!company) {
    await tg.send(chatId, NO_RIGHT);
    return;
  }
  if (!company.departments.length) {
    await tg.send(chatId, "🏢 У Bitrix24 ще не заповнено структуру компанії.");
    return;
  }
  const { text, keyboard } = view.who ? personView(company, view.who) : structureView(company, view.dep ?? 0);
  if (messageId) await tg.edit(chatId, messageId, text, keyboard);
  else await tg.send(chatId, text, { keyboard });
}
