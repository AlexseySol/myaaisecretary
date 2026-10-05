import { Bitrix } from "../bitrix/client";
import { fullName, matchPeople, type Person } from "../bitrix/names";
import { loadDirectory } from "../bot/contacts";
import { bitrixConfigured, type Env } from "../env";
import { Gmail, parseAddresses } from "../google/gmail";
import { hasGmailScope, loadGrant } from "../google/oauth";
import { str, type Tool } from "./runner";

/**
 * Who someone is and their email, by the name the owner wrote («Юлія Григорьєва», «Юлии», «Grigorieva»): the people
 * from the owner's calendar invitations, the company's Bitrix24 users when Bitrix24 is connected (work emails), and —
 * for people outside the company, when neither knows them — the addresses in the owner's recent mail. For the calendar
 * and mail agents, so they look before asking the owner for an email.
 */
export interface Found {
  name: string;
  email: string;
  from: "календар" | "Bitrix24" | "пошта";
  /** The Bitrix24 profile field the email is in (EMAIL, a work field, the company's own UF_ field). */
  field?: string;
  position?: string;
}

export async function findPerson(env: Env, query: string): Promise<Found[]> {
  const out: Found[] = [];
  const seen = new Set<string>();
  const add = (f: Found) => {
    const key = f.email.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };
  const directory = await loadDirectory(env).catch(() => []);
  const asPeople: Person[] = directory.map((d, i) => ({ id: i, name: d.name, lastName: "", email: d.email }));
  for (const m of matchPeople(query, asPeople)) add({ name: m.person.name, email: m.person.email!, from: "календар" });
  if (bitrixConfigured(env)) {
    const people = await new Bitrix(env).findPeople(query).catch((err) => {
      console.warn("find_person: bitrix", err instanceof Error ? err.message : err);
      return [];
    });
    for (const m of people) {
      // Every email in the profile — the main one, a work one in the company's own fields, a personal one.
      const emails = m.person.emails ?? (m.person.email ? [{ field: "EMAIL", email: m.person.email }] : []);
      for (const e of emails) {
        add({ name: fullName(m.person), email: e.email, from: "Bitrix24", field: e.field, ...(m.person.position ? { position: m.person.position } : {}) });
      }
    }
  }
  // People outside the company: the addresses of the owner's recent mail (only when nothing was found above).
  if (!out.length && (await hasGmailScope(env).catch(() => false))) {
    const own = ((await loadGrant(env).catch(() => null))?.email ?? "").toLowerCase();
    const people = (await mailPeople(env).catch(() => [])).filter((p) => p.email !== own);
    const asPeople2: Person[] = people.map((p, i) => ({ id: i, name: p.name, lastName: "", email: p.email }));
    for (const m of matchPeople(query, asPeople2)) add({ name: m.person.name || m.person.email!, email: m.person.email!, from: "пошта" });
  }
  return out.slice(0, 8);
}

/** Names and emails from the owner's recent sent and received mail (headers only), kept 10 minutes. */
let mailCache: { at: number; list: { name: string; email: string }[] } | null = null;

async function mailPeople(env: Env, now = Date.now()): Promise<{ name: string; email: string }[]> {
  if (mailCache && now - mailCache.at < 10 * 60_000) return mailCache.list;
  const gmail = new Gmail(env);
  const ids = [...new Set([...(await gmail.search("in:sent newer_than:365d", 40)), ...(await gmail.search("in:inbox newer_than:180d -category:promotions", 40))])];
  const byEmail = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 10) {
    const lines = await Promise.all(ids.slice(i, i + 10).map((id) => gmail.addressLines(id).catch(() => [] as string[])));
    for (const p of lines.flat().flatMap(parseAddresses)) if (p.name || !byEmail.has(p.email)) byEmail.set(p.email, p.name || byEmail.get(p.email) || "");
  }
  const list = [...byEmail].filter(([, name]) => name).map(([email, name]) => ({ name, email }));
  mailCache = { at: now, list };
  return list;
}

/** Tests start clean. */
export function resetPeopleCache(): void {
  mailCache = null;
}

export function peopleTools(env: Env): Tool[] {
  return [
    {
      spec: {
        name: "find_person",
        description:
          "Find a person's email by the name the owner wrote — any case form or alphabet («Юлії Григорьєвій», «Grigorieva»): searches the owner's calendar contacts" +
          (bitrixConfigured(env) ? ", the company's Bitrix24 users" : "") +
          " and the owner's recent mail (people outside the company). Call it for anyone not in КОНТАКТИ before asking the owner for an email. One person may have several emails (main, work, personal — `field`): show them and ask which to use unless the owner said. Several people — ask which one; none — then ask for the email.",
        parameters: { type: "object", properties: { query: { type: "string", description: "The name exactly as the owner wrote it" } }, required: ["query"] },
      },
      async run(a) {
        const found = await findPerson(env, str(a, "query"));
        return found.length ? { found } : { found: [], note: "Ніде не знайдено — спитай у власника email цієї людини." };
      },
    },
  ];
}
