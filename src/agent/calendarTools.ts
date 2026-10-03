import { type Env, zoomConfigured } from "../env";
import { Calendar, type GEvent } from "../google/calendar";
import { PROP_BOT_CANCEL, PROP_DRAFT, PROP_START } from "../google/sync";
import { randomId } from "../lib/crypto";
import { DAY, formatTime, kyivLocalToDate, kyivParts, MINUTE } from "../lib/time";
import { mark } from "../session";
import { createZoomMeeting } from "../zoom/client";
import { str, type Tool } from "./runner";

/**
 * The tools of the n8n "Calendar MCP Server", one to one. Descriptions are the n8n ones. Invisible to the model:
 * every write the bot makes also records `aisStart` / `aisBotCancel` on the event, so the instant "calendar →
 * Telegram" notices never echo the bot's own changes.
 */

const ISO = "ISO 8601 with Europe/Kyiv offset, e.g. 2026-10-01T14:00:00+03:00";

/** n8n passes attendees as comma-separated JSON objects ({"email":"a@x"},{"email":"b@y"}); plain lists work too. */
export function parseAttendees(value: unknown): { email: string; displayName?: string; responseStatus?: string }[] {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? { email: v } : (v as { email?: string; displayName?: string; responseStatus?: string })))
      .filter((a): a is { email: string } => !!a?.email && a.email.includes("@"));
  }
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return [];
  try {
    const parsed = JSON.parse(text.startsWith("[") ? text : `[${text}]`) as unknown[];
    return parseAttendees(parsed);
  } catch {
    return [...new Set(text.match(/[^\s,;"'{}<>:]+@[^\s,;"'{}<>]+\.[a-z]{2,}/gi) ?? [])].map((email) => ({ email }));
  }
}

/** "через 25 хв" / "через 2 год 10 хв" / "йде зараз" — so answers can say how soon a meeting starts. */
export function startsIn(start: string | undefined, end: string | undefined, now = Date.now()): string | undefined {
  const s = start ? Date.parse(start) : NaN;
  if (Number.isNaN(s)) return undefined;
  const e = end ? Date.parse(end) : s;
  if (s <= now) return e > now ? "йде зараз" : "вже минула";
  const min = Math.round((s - now) / 60_000);
  if (min < 60) return `через ${min} хв`;
  if (min < 24 * 60) return `через ${Math.floor(min / 60)} год${min % 60 ? ` ${min % 60} хв` : ""}`;
  const days = Math.round(min / (24 * 60));
  return `через ${days} ${days === 1 ? "день" : days < 5 ? "дні" : "днів"}`;
}

/** A compact event for the model (no raw noise). */
function brief(ev: GEvent): Record<string, unknown> {
  return {
    id: ev.id,
    status: ev.status,
    summary: ev.summary,
    startsIn: startsIn(ev.start?.dateTime, ev.end?.dateTime),
    start: ev.start?.dateTime ?? ev.start?.date,
    end: ev.end?.dateTime ?? ev.end?.date,
    location: ev.location,
    description: ev.description?.slice(0, 1000),
    hangoutLink: ev.hangoutLink,
    htmlLink: ev.htmlLink,
    organizer: ev.organizer,
    attendees: ev.attendees?.map((a) => ({ email: a.email, name: a.displayName, responseStatus: a.responseStatus, self: a.self })),
  };
}

const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required });
const s = (description: string) => ({ type: "string", description });

/** Words that ask to remove a meeting, and short confirmations (the owner answering «Видалити? (так / ні)»). */
const DELETE_WORDS = /видал|удал|скасу|отмен|відмін|прибер|cancel|delete|remove/i;
const CONFIRM = /^\s*(так|да|yes|ок|ok|давай|підтверджую|подтверждаю)(?=$|[\s,.!])/i;
const ALL_WORDS = /(^|\s)(все|всі|усі|всё|all)(\s|$)/i;

/**
 * Whether the owner's current message allows deleting: a meeting is removed only when THIS message asks for it (never
 * because of something said earlier), and several at once — or «all» — only after an explicit «так».
 */
export function deletionAllowed(currentText: string | undefined, deletedAlready: number, title = ""): string | null {
  if (currentText === undefined) return null;
  const text = currentText.trim();
  const confirmed = CONFIRM.test(text);
  if (!confirmed && !DELETE_WORDS.test(text)) {
    return "The owner's current message does not ask to delete anything. Do NOT delete. Ask what they want.";
  }
  // Each meeting named in the message itself («видали ЫЫ і ТЕСТ») is asked for explicitly.
  const named = title.trim().length >= 2 && text.toLowerCase().includes(title.trim().toLowerCase());
  if (!confirmed && !named && (deletedAlready > 0 || ALL_WORDS.test(text))) {
    return "Deleting several meetings needs the owner's explicit confirmation first: list them and ask «Видалити? (так / ні)». Do not delete now.";
  }
  return null;
}

/**
 * Free windows of at least `minutes` between the busy intervals, within working hours (09:00–19:00 Kyiv) of each day in
 * [from, to], never before `now`.
 */
export function freeWindows(busy: { start: string; end: string }[], from: number, to: number, minutes: number, now = Date.now()): { start: number; end: number }[] {
  const taken = busy.map((b) => [Date.parse(b.start), Date.parse(b.end)] as const).filter(([s, e]) => e > s).sort((x, y) => x[0] - y[0]);
  const out: { start: number; end: number }[] = [];
  if (!(to > from)) return out;
  for (let day = from; day < to + DAY; day += DAY) {
    const p = kyivParts(new Date(day));
    const open = Math.max(kyivLocalToDate(p.year, p.month, p.day, 9).getTime(), from, now);
    const close = Math.min(kyivLocalToDate(p.year, p.month, p.day, 19).getTime(), to);
    let cursor = open;
    for (const [s, e] of taken) {
      if (e <= cursor || s >= close) continue;
      if (s - cursor >= minutes * MINUTE) out.push({ start: cursor, end: s });
      cursor = Math.max(cursor, e);
    }
    if (close - cursor >= minutes * MINUTE) out.push({ start: cursor, end: close });
  }
  // A day counted twice (from/to inside one day) gives the same windows twice: keep each once.
  return out.filter((w, i) => out.findIndex((x) => x.start === w.start) === i);
}

export function calendarTools(env: Env, ownerEmail: string | null, opts: { currentText?: string } = {}): Tool[] {
  const cal = new Calendar(env);
  let deleted = 0;

  const createBody = (a: Record<string, unknown>, extra: Record<string, unknown>) => {
    const start = str(a, "startDateTime");
    const startMs = Date.parse(start);
    if (Number.isNaN(startMs)) throw new Error(`startDateTime must be ${ISO}`);
    const end = str(a, "endDateTime") || new Date(startMs + 60 * 60_000).toISOString();
    return {
      summary: str(a, "summary"),
      start: { dateTime: start, timeZone: "Europe/Kyiv" },
      end: { dateTime: end, timeZone: "Europe/Kyiv" },
      attendees: parseAttendees(a.attendeesJson ?? a.attendees),
      guestsCanModify: false,
      guestsCanInviteOthers: true,
      guestsCanSeeOtherGuests: true,
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
      extendedProperties: { private: { [PROP_DRAFT]: randomId(9), [PROP_START]: String(startMs) } },
      ...extra,
    };
  };

  /**
   * The owner always says who is at a meeting: without other guests a meeting is made only when the owner said so
   * (withoutGuests) — otherwise the agent is told to ask first, never to guess.
   */
  const guestsMissing = (a: Record<string, unknown>): { error: string } | null => {
    const own = (ownerEmail ?? "").toLowerCase();
    const guests = parseAttendees(a.attendeesJson ?? a.attendees).filter((g) => g.email.toLowerCase() !== own);
    if (guests.length || a.withoutGuests === true || a.withoutGuests === "true") return null;
    return {
      error:
        "Зустріч НЕ створено: не відомо, хто буде на зустрічі. Спитай власника: «👥 Хто буде на зустрічі? Напишіть імена чи email (або «без учасників»)». " +
        "withoutGuests=true — лише якщо власник сам сказав, що інших учасників немає.",
    };
  };
  const WITHOUT_GUESTS = {
    type: "boolean",
    description: "true ONLY when the owner said in this conversation that nobody else takes part (just for him / без учасників). Never guess.",
  };

  const tools: Tool[] = [
    {
      spec: {
        name: "get_calendar_events",
        description:
          "Get events from the primary Google Calendar ordered by start time (max 20). Use to show the schedule, or to find an event by its title before changing it. Optional: timeMin, timeMax (" + ISO + "), q (text search, e.g. part of the title).",
        parameters: object({ timeMin: s("Start of the range. Default: now."), timeMax: s("End of the range."), q: s("Free-text search") }, []),
      },
      async run(a) {
        const params: Record<string, string> = {
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: "20",
          timeMin: str(a, "timeMin") || new Date().toISOString(),
        };
        if (str(a, "timeMax")) params.timeMax = str(a, "timeMax");
        if (str(a, "q")) params.q = str(a, "q");
        return (await cal.listEvents(params)).items.map(brief);
      },
    },
    {
      spec: {
        name: "get_event",
        description:
          "Get a single Google Calendar event by its ID. Use when you need full details about a specific event — attendees, time, conference link, description. ALWAYS call this before updating an event to get the current state. Required param: eventId.",
        parameters: object({ eventId: s("The Google Calendar event ID to retrieve") }, ["eventId"]),
      },
      async run(a) {
        return brief(await cal.getEvent(str(a, "eventId")));
      },
    },
    {
      spec: {
        name: "check_free_busy",
        description:
          "Check the owner's busy times and free windows for a time range. Use when user asks 'Am I free at...?', to suggest times when none was given, or before creating a meeting to check for conflicts. Required params: timeMin and timeMax in " + ISO + ". Optional: durationMinutes — free windows at least this long (default 30). Free windows are within 09:00–19:00 Kyiv time, never in the past.",
        parameters: object(
          { timeMin: s("Start of time range to check"), timeMax: s("End of time range to check"), durationMinutes: { type: "integer", description: "Meeting length, minutes" } },
          ["timeMin", "timeMax"],
        ),
      },
      async run(a) {
        const busy = await cal.freeBusy(str(a, "timeMin"), str(a, "timeMax"));
        const free = freeWindows(busy, Date.parse(str(a, "timeMin")), Date.parse(str(a, "timeMax")), Number(a.durationMinutes) || 30);
        return {
          busy: busy.map((b) => ({ start: b.start, end: b.end })),
          free: free.map((w) => ({ day: new Date(w.start).toISOString().slice(0, 10), from: formatTime(new Date(w.start)), to: formatTime(new Date(w.end)), start: new Date(w.start).toISOString() })),
        };
      },
    },
    {
      spec: {
        name: "create_event_google_meet",
        description:
          "Create a Google Calendar event WITH a Google Meet video conferencing link. Use this tool by DEFAULT for any meeting creation unless user explicitly asks for Zoom. Required params: summary (title), startDateTime, endDateTime (" + ISO + "), description (can be empty string). Attendees: attendeesJson (comma-separated JSON objects like {\"email\":\"user@mail.com\"},{\"email\":\"user2@mail.com\"}); without other guests the event is created only with withoutGuests=true, when the owner said so.",
        parameters: object(
          {
            summary: s("Meeting title or topic. Example: Зустріч з Дмитром"),
            description: s("Event description. Use empty string if not specified by user"),
            startDateTime: s("Start time, " + ISO),
            endDateTime: s("End time, " + ISO + ". Default duration 1 hour"),
            attendeesJson: s('Comma-separated JSON attendee objects. Example: {"email":"dmytro@example.com"},{"email":"user@mail.com"}'),
            withoutGuests: WITHOUT_GUESTS,
          },
          ["summary", "startDateTime", "endDateTime"],
        ),
      },
      async run(a) {
        const missing = guestsMissing(a);
        if (missing) return missing;
        const body = createBody(a, {
          description: str(a, "description"),
          conferenceData: { createRequest: { requestId: `meet-${randomId(8)}`, conferenceSolutionKey: { type: "hangoutsMeet" } } },
        });
        return brief(await cal.insertEvent(body));
      },
    },
    {
      spec: {
        name: "create_event_zoom_link",
        description:
          "Create a Google Calendar event with a Zoom meeting link. Use this ONLY when user explicitly asks for Zoom. First call 'create_zoom_meeting' to get the join URL, then call this tool. Required params: summary, startDateTime, endDateTime, zoomJoinUrl. Optional: descriptionWithZoom, attendeesJson.",
        parameters: object(
          {
            summary: s("Meeting title or topic"),
            descriptionWithZoom: s("Event description that MUST include the Zoom join URL. Format: Zoom: https://zoom.us/j/... followed by any other notes"),
            zoomJoinUrl: s("The Zoom meeting join URL from create_zoom_meeting"),
            startDateTime: s("Start time, " + ISO),
            endDateTime: s("End time, " + ISO),
            attendeesJson: s('Comma-separated JSON attendee objects. Example: {"email":"user@mail.com"}'),
            withoutGuests: WITHOUT_GUESTS,
          },
          ["summary", "zoomJoinUrl", "startDateTime", "endDateTime"],
        ),
      },
      async run(a) {
        const missing = guestsMissing(a);
        if (missing) return missing;
        const url = str(a, "zoomJoinUrl");
        const body = createBody(a, { description: str(a, "descriptionWithZoom") || `Zoom: ${url}`, location: url });
        return brief(await cal.insertEvent(body));
      },
    },
    {
      spec: {
        name: "update_event_fields",
        description:
          "Update any field of an existing Google Calendar event — description, summary (title), location, or any combination. Only the specified fields change. ALWAYS call 'get_event' first if you need current values. Required: eventId, patchBody.",
        parameters: object(
          {
            eventId: s("The Google Calendar event ID to update"),
            patchBody: {
              type: "object",
              description: 'ONLY the fields to update, e.g. {"description":"Updated notes"} or {"summary":"New title"}',
              properties: { summary: { type: "string" }, description: { type: "string" }, location: { type: "string" } },
            },
          },
          ["eventId", "patchBody"],
        ),
      },
      async run(a) {
        const p = (typeof a.patchBody === "string" ? JSON.parse(a.patchBody) : a.patchBody ?? {}) as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        for (const k of ["summary", "description", "location"]) if (typeof p[k] === "string") patch[k] = p[k];
        return brief(await cal.patchEvent(str(a, "eventId"), patch));
      },
    },
    {
      spec: {
        name: "reschedule_event",
        description:
          "Reschedule (move) an existing Google Calendar event to a new date/time. Preserves all other event properties (attendees, description, conference link). Required params: eventId, newStartDateTime, newEndDateTime (" + ISO + "). Keep the same duration unless the user said otherwise.",
        parameters: object(
          { eventId: s("The Google Calendar event ID to reschedule"), newStartDateTime: s("New start, " + ISO), newEndDateTime: s("New end, " + ISO) },
          ["eventId", "newStartDateTime", "newEndDateTime"],
        ),
      },
      async run(a) {
        const id = str(a, "eventId");
        const current = await cal.getEvent(id);
        const start = str(a, "newStartDateTime");
        return brief(
          await cal.patchEvent(id, {
            start: { dateTime: start, timeZone: "Europe/Kyiv" },
            end: { dateTime: str(a, "newEndDateTime"), timeZone: "Europe/Kyiv" },
            extendedProperties: { private: { ...(current.extendedProperties?.private ?? {}), [PROP_START]: String(Date.parse(start)) } },
          }),
        );
      },
    },
    {
      spec: {
        name: "manage_event_attendees",
        description:
          "Add or remove attendees of an existing event. IMPORTANT: first call 'get_event' to get current attendees, then pass the FULL updated list here (this REPLACES the entire list). Required params: eventId, attendeesJson.",
        parameters: object(
          {
            eventId: s("The Google Calendar event ID"),
            attendeesJson: s('FULL list of ALL attendees (existing + new), e.g. {"email":"existing@mail.com"},{"email":"new@mail.com"}'),
          },
          ["eventId", "attendeesJson"],
        ),
      },
      async run(a) {
        return brief(await cal.patchEvent(str(a, "eventId"), { attendees: parseAttendees(a.attendeesJson) }));
      },
    },
    {
      spec: {
        name: "rsvp_event",
        description:
          "Accept or decline a Google Calendar event invitation (RSVP) for the owner. Required params: eventId, responseStatus (exactly 'accepted' or 'declined').",
        parameters: object(
          { eventId: s("The Google Calendar event ID"), responseStatus: { type: "string", enum: ["accepted", "declined"] } },
          ["eventId", "responseStatus"],
        ),
      },
      async run(a) {
        const status = str(a, "responseStatus") === "declined" ? "declined" : "accepted";
        const ev = await cal.getEvent(str(a, "eventId"));
        // Only the owner's own answer changes; the rest of the list is kept (a PATCH replaces the whole list).
        const attendees = ev.attendees ?? [];
        const self = attendees.find((x) => x.self || (ownerEmail && x.email.toLowerCase() === ownerEmail));
        if (!self) return { ok: true, note: "The owner organizes this event, so it is already accepted." };
        self.responseStatus = status;
        return brief(await cal.patchEvent(ev.id, { attendees }));
      },
    },
    {
      spec: {
        name: "delete_event",
        description: "Delete an event from the primary Google Calendar; attendees are notified. Required: eventId.",
        parameters: object({ eventId: s("The Google Calendar event ID to delete") }, ["eventId"]),
      },
      async run(a) {
        const id = str(a, "eventId");
        const ev = await cal.getEvent(id);
        const refusal = deletionAllowed(opts.currentText, deleted, ev.summary ?? "");
        if (refusal) return { error: refusal };
        mark(`bot-cancel:${id}`, 10 * 60_000);
        await cal.setPrivate(id, { ...(ev.extendedProperties?.private ?? {}), [PROP_BOT_CANCEL]: "1" }).catch(() => undefined);
        await cal.deleteEvent(id);
        deleted++;
        return { ok: true, deleted: id };
      },
    },
  ];

  if (zoomConfigured(env)) {
    tools.push({
      spec: {
        name: "create_zoom_meeting",
        description: "Create a Zoom meeting and get its join URL. Only when the user explicitly asks for Zoom; then call create_event_zoom_link.",
        parameters: object(
          { topic: s("Meeting title"), startDateTime: s("Start, " + ISO), durationMin: { type: "number", description: "Duration in minutes (default 60)" } },
          ["topic", "startDateTime"],
        ),
      },
      async run(a) {
        const zoom = await createZoomMeeting(env, {
          topic: str(a, "topic") || "Зустріч",
          startIso: new Date(Date.parse(str(a, "startDateTime"))).toISOString(),
          durationMin: Number(a.durationMin) > 0 ? Number(a.durationMin) : 60,
        });
        return { join_url: zoom.join_url };
      },
    });
  }
  return tools;
}
