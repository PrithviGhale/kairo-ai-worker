import { describe, expect, it, vi } from "vitest";

import worker from "./index";
import { ASSISTANT_TOOLS, extractToolCalls, isCalendarDeletionIntent, processAssistantModelResult } from "./assistant-v2";
import { ASSISTANT_V2_MODEL_ID, assistantV2RequestSchema, assistantV2ResponseSchema } from "./assistant-v2-schemas";
import { MAX_REQUEST_BYTES } from "./schemas";
import type { Env } from "./types";

const currentDate = "2026-07-29T14:00:00-04:00";
const timezone = "America/New_York";
const body = (message: string, extra: Record<string, unknown> = {}) => ({
  message, history: [], currentDate, timezone, pendingAction: null,
  appContext: { relevantTasks: [], relevantEvents: [], relevantGoals: [] }, ...extra,
});

const request = (payload: unknown, method = "POST") => new Request("https://worker.test/api/assistant-v2", {
  method, headers: { "Content-Type": "application/json" }, body: method === "POST" ? JSON.stringify(payload) : undefined,
});

const environment = (result: unknown): { env: Env; run: ReturnType<typeof vi.fn> } => {
  const run = vi.fn(async () => result);
  return { env: { AI: { run }, ASSETS: { fetch: vi.fn(async () => new Response("asset")) } }, run };
};

const call = (name: string, args: Record<string, unknown>) => ({ tool_calls: [{ name, arguments: args }] });
const event = (overrides: Record<string, unknown> = {}) => ({
  title: "BTS Concert", date: "2026-08-06", startTime: "20:00", endTime: "00:00", allDay: false,
  location: null, notes: null, reminderMinutesBefore: null, crossesMidnight: true, ...overrides,
});

describe("POST /api/assistant-v2", () => {
  it.each([
    ["normal greeting", "Hello", "Hi! How can I help?"],
    ["general question", "How can I focus better?", "Try a 25-minute focus block with notifications off."],
  ])("returns a validated message for a %s", async (_name, message, reply) => {
    const { env } = environment({ response: reply });
    const response = await worker.fetch(request(body(message)), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, type: "message", reply });
  });

  it("uses gpt-oss-120b with non-streaming traditional function tools", async () => {
    const { env, run } = environment({ response: "Hello." });
    await worker.fetch(request(body("Hello")), env);
    expect(run.mock.calls[0][0]).toBe(ASSISTANT_V2_MODEL_ID);
    expect(run.mock.calls[0][1]).toMatchObject({ tools: ASSISTANT_TOOLS, stream: false, max_tokens: 700 });
    expect(ASSISTANT_TOOLS.map((tool) => tool.function.name)).toEqual([
      "create_calendar_event", "delete_calendar_event", "create_task", "create_savings_goal", "add_goal_contribution", "answer_schedule_question",
    ]);
  });

  it("requests exact local data for next week without calling AI", async () => {
    const { env, run } = environment({ response: "This must not be used." });
    const response = await worker.fetch(request(body("What does my schedule look like next week?")), env);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      type: "tool_call",
      reply: "I’ll check that schedule.",
      toolCall: {
        name: "answer_schedule_question",
        requiresConfirmation: false,
        arguments: {
          questionType: "weekly_overview",
          startDate: "2026-08-03",
          endDate: "2026-08-09",
          rangeLabel: "next week",
          includeEvents: true,
          includeTasks: true,
          includeGoalDeadlines: true,
          includeCompletedTasks: false,
        },
      },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("accepts a validated schedule tool result and returns a grounded normal message", async () => {
    const toolResult = {
      name: "answer_schedule_question",
      range: { startDate: "2026-08-03", endDate: "2026-08-09", rangeLabel: "next week" },
      events: [{ title: "Dentist Appointment", date: "2026-08-04", startTime: "14:00", endTime: "15:00", allDay: false, location: null }],
      tasks: [{ title: "Complete Database Assignment", dueDate: "2026-08-06", dueTime: "20:00", priority: "high", estimatedMinutes: 180, completed: false }],
      goalDeadlines: [],
    };
    const { env, run } = environment({ response: "This must not be used." });
    const response = await worker.fetch(request(body("What does my schedule look like next week?", { toolResult })), env);
    const json = await response.json() as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, type: "message" });
    expect(json.reply).toContain("Schedule: August 3, 2026 through August 9, 2026");
    expect(json.reply).toContain("Dentist Appointment");
    expect(json.reply).toContain("Complete Database Assignment");
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps a data-changing follow-up on a confirmation-required tool", async () => {
    const args = event({ title: "Gym", date: "2026-08-04", startTime: "18:00", endTime: "19:00", crossesMidnight: false });
    const { env } = environment(call("create_calendar_event", args));
    const response = await worker.fetch(request(body("Add gym Tuesday at 6 PM for one hour.", {
      history: [
        { role: "user", content: "What does my schedule look like next week?" },
        { role: "assistant", content: "Schedule: August 3, 2026 through August 9, 2026" },
      ],
    })), env);
    const json = await response.json() as Record<string, any>;
    expect(json.toolCall).toMatchObject({ name: "create_calendar_event", requiresConfirmation: true, arguments: { title: "Gym" } });
  });

  it("grounds a bare weekday action in the previously summarized schedule week", async () => {
    const args = event({ title: "Gym", date: "2026-07-31", startTime: "18:00", endTime: "19:00", crossesMidnight: false });
    const { env } = environment(call("create_calendar_event", args));
    const response = await worker.fetch(request(body("Add gym Friday at 6 PM for one hour.", {
      history: [
        { role: "user", content: "What does my schedule look like next week?" },
        { role: "assistant", content: "Schedule: August 3, 2026 through August 9, 2026" },
      ],
    })), env);
    const json = await response.json() as Record<string, any>;
    expect(json.toolCall).toMatchObject({ name: "create_calendar_event", requiresConfirmation: true, arguments: { title: "Gym", date: "2026-08-07" } });
  });

  it("rejects an invalid or excessive schedule tool result at the request boundary", async () => {
    const invalidToolResult = {
      name: "answer_schedule_question",
      range: { startDate: "2026-01-01", endDate: "2026-05-01", rangeLabel: "too long" },
      events: [{ title: "Private Event", date: "2026-01-02", startTime: null, endTime: null, allDay: true, location: null, databaseId: "private" }],
      tasks: [], goalDeadlines: [],
    };
    const { env } = environment({ response: "unused" });
    const response = await worker.fetch(request(body("What is on my schedule?", { toolResult: invalidToolResult })), env);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "Please provide a valid assistant request." });
  });

  it("proposes the BTS Concert overnight event without an unnecessary follow-up", async () => {
    const { env } = environment(call("create_calendar_event", event()));
    const response = await worker.fetch(request(body("I have a BTS concert August 6 from 8 PM to 12 AM. Add it.")), env);
    const json = await response.json() as Record<string, any>;
    expect(json.type).toBe("tool_call");
    expect(json.toolCall).toEqual({ name: "create_calendar_event", requiresConfirmation: true, arguments: event() });
  });

  it.each([
    ["New York Trip", "2026-08-07", "10:00", "22:00"],
    ["FIFA Game", "2026-08-02", "15:00", "16:45"],
  ])("preserves the complete time range for %s", async (title, date, startTime, endTime) => {
    const args = event({ title, date, startTime, endTime, crossesMidnight: false });
    const { env } = environment(call("create_calendar_event", args));
    const json = await (await worker.fetch(request(body(`Add ${title}`)), env)).json() as Record<string, any>;
    expect(json.type).toBe("tool_call");
    expect(json.toolCall.arguments).toMatchObject({ title, date, startTime, endTime });
  });

  it("asks one exact-time follow-up for a doctor appointment and preserves its draft", async () => {
    const args = event({ title: "Doctor Appointment", date: "2026-08-11", startTime: null, endTime: null, crossesMidnight: false });
    const { env } = environment(call("create_calendar_event", args));
    const json = await (await worker.fetch(request(body("I have a doctor thing next Tuesday morning.")), env)).json() as Record<string, any>;
    expect(json).toMatchObject({ type: "follow_up", reply: "What exact time does the event for Doctor Appointment start?", pendingAction: { action: "create_calendar_event", missingFields: ["startTime"] } });
    expect(json.pendingAction.collectedData).toMatchObject({ title: "Doctor Appointment", date: "2026-08-11" });
  });

  it.each([
    ["task creation", "create_task", { title: "Submit Assignment", description: null, dueDate: "2026-07-30", dueTime: "17:00", priority: "high", estimatedMinutes: 60, notes: null }],
    ["savings-goal creation", "create_savings_goal", { title: "New Laptop", targetAmount: 2000, startingAmount: 250, targetDate: "2026-12-01", description: null }],
    ["contribution creation", "add_goal_contribution", { goalName: "New Laptop", amount: 50, date: "2026-07-29", note: null }],
  ])("supports %s", async (_label, name, args) => {
    const { env } = environment(call(name, args));
    const json = await (await worker.fetch(request(body("Prepare that for me")), env)).json() as Record<string, any>;
    expect(json).toMatchObject({ type: "tool_call", toolCall: { name, requiresConfirmation: true, arguments: args } });
  });

  it.each([
    ["misspellings", "BTS Concert"],
    ["voice-dictation phrasing", "New York Trip"],
  ])("accepts a cleaned title from mocked model understanding of %s", async (_label, title) => {
    const { env } = environment(call("create_calendar_event", event({ title })));
    const json = await (await worker.fetch(request(body("voice input")), env)).json() as Record<string, any>;
    expect(json.toolCall.arguments.title).toBe(title);
  });

  it("preserves context, removes a duplicated newest message, and supplies pending/app context", async () => {
    const message = "Yeah, add that to my calendar.";
    const history = [
      { role: "user", content: "The BTS concert is August 6 from 8 PM to midnight." },
      { role: "assistant", content: "That sounds exciting." },
      { role: "user", content: message },
    ];
    const { env, run } = environment(call("create_calendar_event", event()));
    const response = await worker.fetch(request(body(message, { history, appContext: { relevantTasks: [], relevantEvents: [{ title: "Existing" }], relevantGoals: [] } })), env);
    const messages = run.mock.calls[0][1].messages as Array<{ role: string; content: string }>;
    expect(messages.filter((item) => item.role === "user" && item.content === message)).toHaveLength(1);
    expect(messages.some((item) => item.content.includes("The BTS concert"))).toBe(true);
    expect(messages[0].content).toContain('"relevantEvents":[{"title":"Existing"}]');
    const json = await response.json() as Record<string, any>;
    expect(json.toolCall.arguments.title).toBe("BTS Concert");
  });

  it("merges a pending draft with a focused follow-up answer", async () => {
    const pendingAction = { action: "create_calendar_event", collectedData: { ...event({ startTime: null, endTime: null, crossesMidnight: false }) }, missingFields: ["startTime"] };
    const args = event({ title: "Doctor Appointment", date: "2026-08-11", startTime: "09:00", endTime: null, crossesMidnight: false });
    const { env } = environment(call("create_calendar_event", args));
    const json = await (await worker.fetch(request(body("9 AM", { pendingAction })), env)).json() as Record<string, any>;
    expect(json.type).toBe("tool_call");
    expect(json.toolCall.arguments.startTime).toBe("09:00");
  });

  it("supports OPTIONS and rejects every other method", async () => {
    const { env, run } = environment({ response: "unused" });
    expect((await worker.fetch(new Request("https://worker.test/api/assistant-v2", { method: "OPTIONS" }), env)).status).toBe(204);
    const response = await worker.fetch(request({}, "GET"), env);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST, OPTIONS");
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects an excessively large body before model inference", async () => {
    const { env, run } = environment({ response: "unused" });
    const response = await worker.fetch(request(body("x".repeat(MAX_REQUEST_BYTES))), env);
    expect(response.status).toBe(413);
    expect(run).not.toHaveBeenCalled();
  });

  it("handles quota exhaustion without leaking provider details", async () => {
    const run = vi.fn(async () => { throw new Error("Workers AI neuron quota exceeded: private provider detail"); });
    const env: Env = { AI: { run }, ASSETS: { fetch: vi.fn(async () => new Response("asset")) } };
    const response = await worker.fetch(request(body("Hello")), env);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "Kairo's free AI allowance is temporarily exhausted. Please try again later." });
  });

  it("returns an ID-free confirmation-required calendar deletion proposal", async () => {
    const args = { eventReference: { title: "BTS Concert", date: "2026-08-06", startTime: "20:00", endTime: "00:00", location: null }, reason: "not_attending" };
    const { env } = environment(call("delete_calendar_event", args));
    const response = await worker.fetch(request(body("I'm not going to the BTS concert anymore.")), env);
    const json = await response.json() as Record<string, any>;
    expect(json).toEqual({ ok: true, type: "tool_call", reply: "I found the event you want to remove. Please confirm before it is deleted.", toolCall: { name: "delete_calendar_event", requiresConfirmation: true, arguments: args } });
    expect(JSON.stringify(json)).not.toMatch(/eventId|databaseId|repositoryId|rowId/);
  });

  it("resolves a contextual deletion reference from one relevant local event", () => {
    const parsed = assistantV2RequestSchema.parse(body("That got canceled. Remove it.", {
      appContext: { relevantTasks: [], relevantGoals: [], relevantEvents: [{ title: "Dentist Appointment", startAt: "2026-08-04T18:00:00.000Z", endAt: "2026-08-04T18:30:00.000Z", isAllDay: false }] },
    }));
    const result = processAssistantModelResult(parsed, call("delete_calendar_event", { eventReference: { title: "That Event", date: null, startTime: null, endTime: null, location: null }, reason: "canceled" }));
    expect(result).toMatchObject({ type: "tool_call", toolCall: { name: "delete_calendar_event", requiresConfirmation: true, arguments: { eventReference: { title: "Dentist Appointment", date: "2026-08-04", startTime: "14:00", endTime: "14:30" }, reason: "canceled" } } });
  });

  it("deterministically cleans cancellation wording and selects the named local event", () => {
    const parsed = assistantV2RequestSchema.parse(body("My dentist appointment got canceled.", {
      appContext: { relevantTasks: [], relevantGoals: [], relevantEvents: [
        { title: "Dentist Appointment", startAt: "2026-08-04T18:00:00.000Z", endAt: "2026-08-04T18:30:00.000Z", isAllDay: false },
        { title: "Team Sync", startAt: "2026-08-05T19:00:00.000Z", endAt: "2026-08-05T20:00:00.000Z", isAllDay: false },
      ] },
    }));
    const result = processAssistantModelResult(parsed, { response: "I understand." });
    expect(result).toMatchObject({ type: "tool_call", toolCall: { name: "delete_calendar_event", arguments: { eventReference: { title: "Dentist Appointment", date: "2026-08-04", startTime: "14:00" }, reason: "canceled" } } });
  });

  it("uses a clock-only contextual reference to select the one matching event", () => {
    const parsed = assistantV2RequestSchema.parse(body("Take the 3 PM event off my calendar.", {
      appContext: { relevantTasks: [], relevantGoals: [], relevantEvents: [
        { title: "Dentist Appointment", startAt: "2026-08-04T18:00:00.000Z", endAt: "2026-08-04T18:30:00.000Z", isAllDay: false },
        { title: "Team Sync", startAt: "2026-08-04T19:00:00.000Z", endAt: "2026-08-04T20:00:00.000Z", isAllDay: false },
      ] },
    }));
    const result = processAssistantModelResult(parsed, { response: "I understand." });
    expect(result).toMatchObject({ type: "tool_call", toolCall: { name: "delete_calendar_event", arguments: { eventReference: { title: "Team Sync", startTime: "15:00" }, reason: "user_requested" } } });
  });

  it("asks for one date or time when multiple saved events match", () => {
    const parsed = assistantV2RequestSchema.parse(body("Cancel the FIFA game.", {
      appContext: { relevantTasks: [], relevantGoals: [], relevantEvents: [
        { title: "FIFA Game", startAt: "2026-08-02T19:00:00.000Z", endAt: "2026-08-02T20:45:00.000Z", isAllDay: false },
        { title: "FIFA Game", startAt: "2026-08-09T19:00:00.000Z", endAt: "2026-08-09T20:45:00.000Z", isAllDay: false },
      ] },
    }));
    const result = processAssistantModelResult(parsed, call("delete_calendar_event", { eventReference: { title: "FIFA Game", date: null, startTime: null, endTime: null, location: null }, reason: "user_requested" }));
    expect(result).toMatchObject({ type: "follow_up", reply: "I found more than one matching event. Which date or time should I remove?", pendingAction: { action: "delete_calendar_event", missingFields: ["eventDateOrTime"], collectedData: { eventReference: { title: "FIFA Game" } } } });
  });

  it.each([
    ["My dentist appointment got canceled.", true],
    ["Cancel my dentist appointment Tuesday.", true],
    ["I'm not going to the BTS concert anymore.", true],
    ["Remove the FIFA game from my calendar.", true],
    ["Delete my New York trip.", true],
    ["I cannot make it to dinner Friday.", true],
    ["That event was canceled.", true],
    ["Remove that from my schedule.", true],
    ["I'm no longer going to it.", true],
    ["My concert might get canceled.", false],
    ["What happens if my dentist cancels?", false],
    ["Never mind", false],
    ["Cancel this request", false],
    ["Cancel", false],
  ])("classifies calendar deletion intent for %s", (message, expected) => {
    expect(isCalendarDeletionIntent(message)).toBe(expected);
  });
});

describe("assistant-v2 strict model response validation", () => {
  const parsedRequest = assistantV2RequestSchema.parse(body("Prepare this"));

  it.each([
    ["unknown tool", call("delete_task", {})],
    ["unknown field", call("create_calendar_event", event({ databaseId: "secret" }))],
    ["invalid date", call("create_calendar_event", event({ date: "2026-02-30" }))],
    ["invalid range", call("create_calendar_event", event({ startTime: "20:00", endTime: "19:00", crossesMidnight: false }))],
    ["non-positive contribution", call("add_goal_contribution", { goalName: "Trip", amount: 0, date: "2026-07-29", note: null })],
    ["invented deletion ID", call("delete_calendar_event", { eventReference: { title: "BTS Concert", date: "2026-08-06", startTime: "20:00", endTime: "00:00", location: null, eventId: "invented" }, reason: "user_requested" })],
    ["unsupported full-series deletion", call("delete_calendar_event", { eventReference: { title: "Practice", date: "2026-08-06", startTime: "20:00", endTime: "21:00", location: null }, reason: "user_requested", scope: "series" })],
  ])("rejects %s", (_label, result) => {
    expect(() => processAssistantModelResult(parsedRequest, result)).toThrow("MODEL_RESPONSE_INVALID");
  });

  it("rejects conversational mutation claims", () => {
    expect(() => processAssistantModelResult(parsedRequest, { response: "I added the event to your calendar." })).toThrow("MODEL_RESPONSE_INVALID");
    expect(() => processAssistantModelResult(parsedRequest, { response: "I deleted the event." })).toThrow("MODEL_RESPONSE_INVALID");
    expect(() => processAssistantModelResult(parsedRequest, { response: "Your event is canceled." })).toThrow("MODEL_RESPONSE_INVALID");
  });

  it("creates one follow-up when a required goal amount is missing", () => {
    const result = processAssistantModelResult(parsedRequest, call("create_savings_goal", { title: "Trip", targetAmount: null, startingAmount: 0, targetDate: null, description: null }));
    expect(result).toMatchObject({ type: "follow_up", pendingAction: { missingFields: ["targetAmount"] } });
  });

  it("parses current direct and OpenAI chat-completions tool-call shapes", () => {
    expect(extractToolCalls(call("create_task", { title: "A" }))).toEqual([{ name: "create_task", arguments: { title: "A" } }]);
    expect(extractToolCalls({ choices: [{ message: { tool_calls: [{ function: { name: "create_task", arguments: '{"title":"A"}' } }] } }] })).toEqual([{ name: "create_task", arguments: { title: "A" } }]);
  });

  it("keeps all successful output variants inside the public response union", () => {
    expect(assistantV2ResponseSchema.safeParse({ ok: true, type: "message", reply: "Hello." }).success).toBe(true);
  });
});
