import { describe, expect, it, vi } from "vitest";

import worker from "./index";
import { MAX_REQUEST_BYTES, proposedActionResponseSchema } from "./schemas";
import { STRUCTURED_MODEL_ID } from "./structured";
import type { Env } from "./types";

const currentDate = "2026-07-17T14:00:00.000Z";
const timezone = "America/New_York";

const messageCandidate = { kind: "message", reply: "I am ready to help.", confidence: 0.9, title: "", location: "" };
const proposedCandidate = {
  kind: "create_event",
  reply: "Here is the event I prepared.",
  confidence: 0.95,
  title: "FIFA Game",
  location: "",
};
const followUpCandidate = {
  kind: "create_event",
  reply: "What information is missing?",
  confidence: 0.85,
  title: "FIFA Game",
  location: "",
};

const environment = (response: unknown) => {
  const run = vi.fn(async (_model: string, _input: Record<string, unknown>) => ({ response }));
  const env: Env = { AI: { run }, ASSETS: { fetch: vi.fn(async () => new Response("asset")) } };
  return { env, run };
};

const request = (path: string, body: unknown, method = "POST", headers: Record<string, string> = {}) => new Request(`https://worker.test${path}`, {
  method,
  headers: { "Content-Type": "application/json", ...headers },
  body: method === "POST" ? JSON.stringify(body) : undefined,
});

const structuredBody = (message: string, history: unknown[] = []) => ({ message, history, currentDate, timezone });

describe("Worker routes", () => {
  it("preserves the health route", async () => {
    const { env } = environment(messageCandidate);
    const response = await worker.fetch(new Request("https://worker.test/health"), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "Kairo AI", status: "ready" });
  });

  it("preserves the conversational endpoint", async () => {
    const { env, run } = environment("A conversational reply");
    const response = await worker.fetch(request("/api/kairo", { message: "How are you?", currentDate, timezone }), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, reply: "A conversational reply" });
    expect(run.mock.calls[0][0]).toBe("@cf/meta/llama-3.1-8b-instruct-fp8");
  });

  it("supports OPTIONS and rejects unsupported structured methods", async () => {
    const { env } = environment(messageCandidate);
    expect((await worker.fetch(new Request("https://worker.test/api/kairo-structured", { method: "OPTIONS" }), env)).status).toBe(204);
    const response = await worker.fetch(new Request("https://worker.test/api/kairo-structured"), env);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST, OPTIONS");
  });
});

describe("structured endpoint", () => {
  it("returns a normal validated message for non-calendar input", async () => {
    const { env, run } = environment(messageCandidate);
    const response = await worker.fetch(request("/api/kairo-structured", structuredBody("Hello")), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, type: "message", reply: messageCandidate.reply });
    expect(run.mock.calls[0][0]).toBe(STRUCTURED_MODEL_ID);
    expect((run.mock.calls[0][1] as Record<string, unknown>).response_format).toMatchObject({ type: "json_schema" });
  });

  it("returns a complete FIFA proposed action with the correct range", async () => {
    const { env, run } = environment(proposedCandidate);
    const response = await worker.fetch(request("/api/kairo-structured", structuredBody("Add to my calendar I have FIFA game Sunday at 3 PM till 4:45 PM")), env);
    expect(response.status).toBe(200);
    const json = await response.json() as { type: string; reply: string; action: Record<string, unknown> };
    expect(json.type).toBe("proposed_action");
    expect(json.reply.toLowerCase()).not.toContain("how long");
    expect(json.action).toMatchObject({
      action: "create_event",
      requiresConfirmation: true,
      originalMessage: "Add to my calendar I have FIFA game Sunday at 3 PM till 4:45 PM",
      data: { title: "FIFA Game", date: "2026-07-19", startTime: "15:00", endTime: "16:45" },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("returns a date follow-up while preserving the supplied time range", async () => {
    const { env } = environment(followUpCandidate);
    const response = await worker.fetch(request("/api/kairo-structured", structuredBody("Add FIFA game at 3 PM till 4:45 PM")), env);
    const json = await response.json() as { type: string; pendingAction: { collectedData: unknown; missingFields: string[] } };
    expect(json.type).toBe("follow_up");
    expect(json.pendingAction.missingFields).toEqual(["date"]);
    expect(json.pendingAction.collectedData).toMatchObject({ title: "FIFA Game", startTime: "15:00", endTime: "16:45" });
  });

  it("returns a missing-time follow-up without inventing a time", async () => {
    const { env } = environment(followUpCandidate);
    const response = await worker.fetch(request("/api/kairo-structured", structuredBody("Add FIFA game Sunday")), env);
    const json = await response.json() as { pendingAction: { collectedData: Record<string, unknown>; missingFields: string[] } };
    expect(json.pendingAction.missingFields).toEqual(["startTimeOrAllDay"]);
    expect(json.pendingAction.collectedData.startTime).toBeUndefined();
  });

  it("preserves an explicit duration while asking for a missing start time", async () => {
    const { env } = environment(followUpCandidate);
    const response = await worker.fetch(request("/api/kairo-structured", structuredBody("Block one hour after work Thursday for my assignment")), env);
    const json = await response.json() as { pendingAction: { collectedData: Record<string, unknown>; missingFields: string[] } };
    expect(json.pendingAction.missingFields).toEqual(["startTimeOrAllDay"]);
    expect(json.pendingAction.collectedData.durationMinutes).toBe(60);
  });

  it("rejects invalid request date and timezone metadata before calling the model", async () => {
    const { env, run } = environment(messageCandidate);
    const invalidDate = await worker.fetch(request("/api/kairo-structured", { message: "Add lunch", history: [], currentDate: "tomorrow", timezone }), env);
    const invalidTimezone = await worker.fetch(request("/api/kairo-structured", { message: "Add lunch", history: [], currentDate, timezone: "Mars/Olympus" }), env);
    expect(invalidDate.status).toBe(400);
    expect(invalidTimezone.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("asks AM or PM for an ambiguous range", async () => {
    const { env } = environment(followUpCandidate);
    const response = await worker.fetch(request("/api/kairo-structured", structuredBody("Add FIFA game Sunday from 3 to 4:45")), env);
    const json = await response.json() as { reply: string; pendingAction: { missingFields: string[] } };
    expect(json.reply).toBe("Is that 3:00–4:45 AM or PM?");
    expect(json.pendingAction.missingFields).toEqual(["timeMeridiem"]);
  });

  it("limits history sent to the model to the latest eight valid messages", async () => {
    const history = Array.from({ length: 12 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `Message ${index}` }));
    const { env, run } = environment(messageCandidate);
    await worker.fetch(request("/api/kairo-structured", structuredBody("Hello", [{ bad: true }, ...history])), env);
    const messages = (run.mock.calls[0][1] as { messages: Array<{ content: string }> }).messages;
    expect(messages).toHaveLength(10);
    expect(messages[1].content).toBe("Message 4");
  });

  it("rejects a request body over the byte limit", async () => {
    const { env, run } = environment(messageCandidate);
    const response = await worker.fetch(request("/api/kairo-structured", structuredBody("x".repeat(MAX_REQUEST_BYTES))), env);
    expect(response.status).toBe(413);
    expect(run).not.toHaveBeenCalled();
  });

  it("requires JSON content type", async () => {
    const { env } = environment(messageCandidate);
    const response = await worker.fetch(new Request("https://worker.test/api/kairo-structured", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "hello" }), env);
    expect(response.status).toBe(415);
  });

  it.each([
    ["invalid model JSON", "{not json"],
    ["unknown action", { ...proposedCandidate, kind: "delete_event" }],
    ["unexpected database fields", { ...proposedCandidate, databaseId: "should-not-pass" }],
    ["invalid confidence", { ...proposedCandidate, confidence: 1.5 }],
    ["persistence claim", { ...proposedCandidate, reply: "I added the event to your calendar." }],
  ])("rejects %s", async (_name, candidate) => {
    const { env } = environment(candidate);
    const response = await worker.fetch(request("/api/kairo-structured", structuredBody("Hello")), env);
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "Kairo could not safely interpret that calendar request." });
  });

  it("strictly rejects invalid dates and time ranges in final actions", () => {
    const validAction = {
      ok: true,
      type: "proposed_action",
      reply: "Here is the event I prepared for your confirmation.",
      action: {
        action: "create_event",
        requiresConfirmation: true,
        confidence: 0.9,
        originalMessage: "Add the FIFA game",
        data: {
          title: "FIFA Game",
          date: "2026-07-19",
          startTime: "15:00",
          endTime: "16:45",
          allDay: false,
          crossesMidnight: false,
          location: null,
          reminderMinutesBefore: null,
          description: null,
        },
      },
    };
    const invalidDate = { ...validAction, action: { ...validAction.action, data: { ...validAction.action.data, date: "2026-02-30" } } };
    const invalidRange = { ...validAction, action: { ...validAction.action, data: { ...validAction.action.data, startTime: "17:00", endTime: "16:00" } } };
    expect(proposedActionResponseSchema.safeParse(invalidDate).success).toBe(false);
    expect(proposedActionResponseSchema.safeParse(invalidRange).success).toBe(false);
  });
});
