import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BITRIX_READ, resetBitrixCache, toPerson } from "../src/bitrix/client";
import { type Company, manager, personView, structureForAgent, structureView } from "../src/bitrix/structure";
import { handleUpdate } from "../src/telegram/handler";
import { lastBotMessage, mockFetch, OWNER, resetInstance, testEnv, tgCalls } from "./helpers";

beforeEach(() => {
  resetInstance();
  resetBitrixCache();
});
afterEach(() => vi.restoreAllMocks());

const person = (id: number, name: string, lastName: string, position: string, dep: number[]) =>
  toPerson({ ID: String(id), NAME: name, LAST_NAME: lastName, WORK_POSITION: position, UF_DEPARTMENT: dep, EMAIL: `${name.toLowerCase()}@acme.ua` });

const company: Company = {
  departments: [
    { id: 1, name: "Компанія", headId: 1, sort: 100 },
    { id: 2, name: "Продажі", parent: 1, headId: 2, sort: 200 },
    { id: 3, name: "B2B", parent: 2, headId: 4, sort: 300 },
    { id: 4, name: "Бухгалтерія", parent: 1, headId: 5, sort: 400 },
  ],
  people: [
    person(1, "Олександр", "Коваленко", "Директор", [1]),
    person(2, "Олена", "Коваль", "Керівник продажів", [2]),
    person(3, "Іван", "Петренко", "Менеджер", [2]),
    person(4, "Петро", "Сидоренко", "Менеджер B2B", [3]),
    person(5, "Марія", "Шевчук", "Головний бухгалтер", [4]),
  ],
};

describe("the company structure (read from Bitrix24)", () => {
  it("whom each one reports to: their department's head, or the head above for a head", () => {
    const by = (id: number) => company.people.find((p) => p.id === id)!;
    expect(manager(company, by(3))?.name).toBe("Олена");
    expect(manager(company, by(2))?.name).toBe("Олександр");
    expect(manager(company, by(4))?.name).toBe("Олена");
    expect(manager(company, by(1))).toBeUndefined();
  });

  it("the tree, a department with its people and subdepartments, a person's card", () => {
    const root = structureView(company, 0);
    expect(root.text).toContain("🏢 <b>Структура компанії</b>");
    expect(root.text).toContain("📂 <b>Компанія</b> — 👤 Олександр Коваленко · 5");
    expect(root.text).toContain("└ Продажі — Олена Коваль · 3");

    const sales = structureView(company, 2);
    expect(sales.text).toContain("👤 <b>Керівник:</b> Олена Коваль — Керівник продажів");
    expect(sales.text).toContain("👥 <b>Людей:</b> 3 (з підрозділами)");
    expect(sales.text).toContain("• Іван Петренко — <i>Менеджер</i>");
    const data = sales.keyboard.flat().map((b) => b.callback_data);
    expect(data).toEqual(expect.arrayContaining(["bx:dep:3", "bx:who:3", "bx:dep:1"]));

    const card = personView(company, 3);
    expect(card.text).toContain("👤 <b>Іван Петренко</b>");
    expect(card.text).toContain("📂 Продажі");
    expect(card.text).toContain("⬆️ Керівник: Олена Коваль");
    expect(card.keyboard.flat().map((b) => b.callback_data)).toEqual(["bx:wt:3", "bx:dep:2"]);
  });

  it("for the agent: the tree, or one department with every person", () => {
    expect(JSON.stringify(structureForAgent(company))).toContain('"name":"B2B","head":"Петро Сидоренко","people":1');
    const sales = structureForAgent(company, "прод") as { departments: { head: { name: string }; people: { name: string }[] }[] };
    expect(sales.departments[0]!.head.name).toBe("Олена Коваль");
    expect(sales.departments[0]!.people.map((p) => p.name)).toEqual(["Олена Коваль", "Іван Петренко"]);
  });

  it("only reads: department.get is the one structure method the bot may call", () => {
    expect(BITRIX_READ.has("department.get")).toBe(true);
    expect([...BITRIX_READ].filter((m) => m.startsWith("department."))).toEqual(["department.get"]);
  });
});

describe("/team in the chat", () => {
  const WEBHOOK = "https://acme.bitrix24.ua/rest/1/secret/";
  const from = { id: OWNER, is_bot: false, first_name: "О" };
  const say = (text: string) => ({ update_id: 1, message: { message_id: 5, date: 0, chat: { id: OWNER, type: "private" as const }, from, text } });

  it("without the «Структура компанії» right: says what to add, nothing breaks", async () => {
    mockFetch([
      (url) =>
        url.href.startsWith(WEBHOOK)
          ? url.pathname.endsWith("department.get.json")
            ? Response.json({ error: "insufficient_scope", error_description: "The request requires higher privileges" }, { status: 401 })
            : Response.json({ result: [] })
          : undefined,
    ]);
    const { env } = testEnv({ BITRIX_WEBHOOK_URL: WEBHOOK });
    await handleUpdate(env, say("/team"));
    expect(lastBotMessage("Структура компанії").text).toContain("недоступна");
  });

  it("with it: the tree; a department button edits the same message", async () => {
    const calls = mockFetch([
      (url) => {
        if (!url.href.startsWith(WEBHOOK)) return undefined;
        if (url.pathname.endsWith("department.get.json"))
          return Response.json({ result: [{ ID: "1", NAME: "Компанія", SORT: "100", UF_HEAD: "1" }, { ID: "2", NAME: "Продажі", SORT: "200", PARENT: "1", UF_HEAD: "2" }] });
        if (url.pathname.endsWith("user.get.json"))
          return Response.json({ result: [{ ID: "1", NAME: "Олександр", LAST_NAME: "Коваленко", UF_DEPARTMENT: [1] }, { ID: "2", NAME: "Олена", LAST_NAME: "Коваль", UF_DEPARTMENT: [2] }] });
        return Response.json({ result: [] });
      },
    ]);
    const { env } = testEnv({ BITRIX_WEBHOOK_URL: WEBHOOK });
    await handleUpdate(env, say("/team"));
    const tree = lastBotMessage("Структура компанії");
    expect(tree.text).toContain("Продажі");
    await handleUpdate(env, { update_id: 2, callback_query: { id: "c", from, data: "bx:dep:2", message: tree } });
    expect(String(tgCalls(calls, "editMessageText").at(-1)!.text)).toContain("Керівник:</b> Олена Коваль");
  });
});
