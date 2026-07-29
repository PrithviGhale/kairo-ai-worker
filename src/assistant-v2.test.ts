import { describe, expect, it, vi } from "vitest";

import worker from "./index";
import { ASSISTANT_TOOLS, extractToolCalls, processAssistantModelResult } from "./assistant-v2";
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
    expect(ASSISTANT_TOOLS.map((tool) => tool.name)).toEqual([
      "create_calendar_event", "create_task", "create_savings_goal", "add_goal_contribution", "answer_schedule_question",
    ]);
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
    const args = event({ title: "Doctor Appointment", date: "2026-08-04", startTime: null, endTime: null, crossesMidnight: false });
    const { env } = environment(call("create_calendar_event", args));
    const json = await (await worker.fetch(request(body("I have a doctor thing next Tuesday morning.")), env)).json() as Record<string, any>;
    expect(json).toMatchObject({ type: "follow_up", reply: "What exact time does the event for Doctor Appointment start?", pendingAction: { action: "create_calendar_event", missingFields: ["startTime"] } });
    expect(json.pendingAction.collectedData).toMatchObject({ title: "Doctor Appointment", date: "2026-08-04" });
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
    await worker.fetch(request(body(message, { history, appContext: { relevantTasks: [], relevantEvents: [{ title: "Existing" }], relevantGoals: [] } })), env);
    const messages = run.mock.calls[0][1].messages as Array<{ role: string; content: string }>;
    expect(messages.filter((item) => item.role === "user" && item.content === message)).toHaveLength(1);
    expect(messages.some((item) => item.content.includes("The BTS concert"))).toBe(true);
    expect(messages[0].content).toContain('"relevantEvents":[{"title":"Existing"}]');
  });

  it("merges a pending draft with a focused follow-up answer", async () => {
    const pendingAction = { action: "create_calendar_event", collectedData: { ...event({ startTime: null, endTime: null, crossesMidnight: false }) }, missingFields: ["startTime"] };
    const args = event({ title: "Doctor Appointment", date: "2026-08-04", startTime: "09:00", endTime: null, crossesMidnight: false });
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
});

describe("assistant-v2 strict model response validation", () => {
  const parsedRequest = assistantV2RequestSchema.parse(body("Prepare this"));

  it.each([
    ["unknown tool", call("delete_task", {})],
    ["unknown field", call("create_calendar_event", event({ databaseId: "secret" }))],
    ["invalid date", call("create_calendar_event", event({ date: "2026-02-30" }))],
    ["invalid range", call("create_calendar_event", event({ startTime: "20:00", endTime: "19:00", crossesMidnight: false }))],
    ["non-positive contribution", call("add_goal_contribution", { goalName: "Trip", amount: 0, date: "2026-07-29", note: null })],
  ])("rejects %s", (_label, result) => {
    expect(() => processAssistantModelResult(parsedRequest, result)).toThrow("MODEL_RESPONSE_INVALID");
  });

  it("rejects conversational mutation claims", () => {
    expect(() => processAssistantModelResult(parsedRequest, { response: "I added the event to your calendar." })).toThrow("MODEL_RESPONSE_INVALID");
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
