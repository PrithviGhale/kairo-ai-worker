import { describe, expect, it, vi } from "vitest";

import worker from "./index";
import {
  checkinInsightsToolResultSchema,
  dailyBriefingToolResultSchema,
  savingsProgressToolResultSchema,
} from "./intelligence-schemas";
import type { Env } from "./types";

const currentDate = "2026-07-29T10:00:00-04:00";
const timezone = "America/New_York";
const body = (message: string, extra: Record<string, unknown> = {}) => ({
  message,
  history: [],
  currentDate,
  timezone,
  pendingAction: null,
  appContext: { relevantTasks: [], relevantEvents: [], relevantGoals: [] },
  ...extra,
});
const request = (payload: unknown) => new Request("https://worker.test/api/assistant-v2", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
const environment = (): { env: Env; run: ReturnType<typeof vi.fn> } => {
  const run = vi.fn(async () => ({ response: "AI must not be used for a local read." }));
  return { env: { AI: { run }, ASSETS: { fetch: vi.fn(async () => new Response("asset")) } }, run };
};

const iphoneGoal = (overrides: Record<string, unknown> = {}) => ({
  title: "New iPhone",
  targetAmount: 1200,
  currentAmount: 300,
  remainingAmount: 900,
  progressPercent: 25,
  targetDate: "2026-08-10",
  lastContributionDate: "2026-07-24",
  ...overrides,
});

const checkinResult = (overrides: Record<string, unknown> = {}) => ({
  name: "read_checkin_insights",
  range: { startDate: "2026-07-16", endDate: "2026-07-29" },
  totalCheckIns: 12,
  currentCheckIn: { date: "2026-07-29", mood: "tired", energy: 2, stress: 3 },
  moodCounts: { great: 2, good: 4, okay: 3, tired: 2, stressed: 1, low: 0 },
  averageEnergy: 3.2,
  averageStress: 2.8,
  weekdayPatterns: [{ weekday: "Monday", sampleCount: 3, averageEnergy: 2.3, mostCommonMood: "tired" }],
  ...overrides,
});

const briefingResult = (overrides: Record<string, unknown> = {}) => ({
  name: "generate_daily_briefing",
  preferredName: "Praanshu",
  localDate: "2026-07-29",
  timezone,
  currentCheckIn: { mood: "tired", energy: 2, stress: 3 },
  today: {
    events: [{ title: "Team Meeting", startTime: "14:00", endTime: "14:30", allDay: false }],
    tasks: [{ title: "Submit Assignment", dueDate: "2026-07-29", dueTime: "17:00", priority: "high", estimatedMinutes: 60 }],
    overdueTasks: [],
  },
  week: { eventCount: 5, taskCount: 4, busiestDay: "Thursday", openDays: ["Wednesday"] },
  featuredSavingsGoal: { title: "New iPhone", currentAmount: 300, targetAmount: 1200, progressPercent: 25 },
  recentCheckInInsights: { totalCheckIns: 10, averageEnergy: 3.1, averageStress: 2.7 },
  ...overrides,
});

describe("read-only savings intelligence", () => {
  it("routes a general savings question locally with no confirmation", async () => {
    const { env, run } = environment();
    const response = await worker.fetch(request(body("How are my savings looking?")), env);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      type: "tool_call",
      reply: "I’ll check your active savings progress.",
      toolCall: {
        name: "read_savings_progress",
        requiresConfirmation: false,
        arguments: { goalName: null, includeAllActiveGoals: true, includeCompletedGoals: false },
      },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("requests a named goal without copying unrelated wording", async () => {
    const { env } = environment();
    const json = await (await worker.fetch(request(body("How close am I to my iPhone goal?")), env)).json() as any;
    expect(json.toolCall).toMatchObject({
      name: "read_savings_progress",
      requiresConfirmation: false,
      arguments: { goalName: "iPhone", includeCompletedGoals: false },
    });
  });

  it("summarizes one active goal using only validated device totals", async () => {
    const { env, run } = environment();
    const toolResult = { name: "read_savings_progress", goals: [iphoneGoal()] };
    const json = await (await worker.fetch(request(body("How are my savings looking?", { toolResult })), env)).json() as any;
    expect(json).toMatchObject({ ok: true, type: "message" });
    expect(json.reply).toContain("$300 of $1,200 (25%)");
    expect(json.reply).toContain("$900 remaining");
    expect(json.reply).not.toMatch(/deposit|contribut(?:ed|ion)|behind/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("summarizes multiple goals, identifies the closest, and notes approaching deadlines cautiously", async () => {
    const { env } = environment();
    const toolResult = {
      name: "read_savings_progress",
      goals: [
        iphoneGoal(),
        iphoneGoal({ title: "Trip", targetAmount: 1000, currentAmount: 800, remainingAmount: 200, progressPercent: 80, targetDate: "2026-12-01" }),
      ],
    };
    const json = await (await worker.fetch(request(body("How are my savings looking?", { toolResult })), env)).json() as any;
    expect(json.reply).toContain("New iPhone");
    expect(json.reply).toContain("Trip is currently closest");
    expect(json.reply).toContain("Approaching deadlines: New iPhone");
    expect(json.reply).not.toContain("behind");
  });

  it("handles no active goals without inventing balances", async () => {
    const { env } = environment();
    const toolResult = { name: "read_savings_progress", goals: [] };
    const json = await (await worker.fetch(request(body("How are my savings looking?", { toolResult })), env)).json() as any;
    expect(json.reply).toBe("I could not find any active savings goals in the data provided by your device.");
  });

  it.each([
    ["negative money", { name: "read_savings_progress", goals: [iphoneGoal({ currentAmount: -1 })] }],
    ["incorrect remaining", { name: "read_savings_progress", goals: [iphoneGoal({ remainingAmount: 1 })] }],
    ["incorrect percentage", { name: "read_savings_progress", goals: [iphoneGoal({ progressPercent: 99 })] }],
    ["database ID", { name: "read_savings_progress", goals: [iphoneGoal({ id: "private" })] }],
    ["raw contribution history", { name: "read_savings_progress", goals: [iphoneGoal({ contributions: [{ amount: 50 }] })] }],
  ])("rejects %s in savings results", async (_label, toolResult) => {
    const { env } = environment();
    const response = await worker.fetch(request(body("How are my savings looking?", { toolResult })), env);
    expect(response.status).toBe(400);
  });
});

describe("read-only check-in insights", () => {
  it.each([
    ["How have I been feeling this week?", "7_days"],
    ["Show my mood patterns this month.", "30_days"],
    ["How have I been feeling lately?", "14_days"],
  ])("routes %s to the requested aggregate range", async (message, range) => {
    const { env, run } = environment();
    const json = await (await worker.fetch(request(body(message)), env)).json() as any;
    expect(json.toolCall).toEqual({
      name: "read_checkin_insights",
      requiresConfirmation: false,
      arguments: { range, includeWeekdayPatterns: true, includeCurrentCheckIn: true },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["tired", "feeling tired"],
    ["stressed", "feeling stressed"],
    ["great", "feeling great"],
  ])("summarizes a current %s check-in without diagnosis", async (mood, phrase) => {
    const counts = { great: 2, good: 4, okay: 3, tired: 2, stressed: 1, low: 0, [mood]: 2 };
    const totalCheckIns = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const toolResult = checkinResult({ totalCheckIns, moodCounts: counts, currentCheckIn: { date: "2026-07-29", mood, energy: mood === "great" ? 5 : 2, stress: mood === "stressed" ? 5 : 3 } });
    const { env } = environment();
    const json = await (await worker.fetch(request(body("How have I been feeling lately?", { toolResult })), env)).json() as any;
    expect(json.reply).toContain(phrase);
    expect(json.reply).not.toMatch(/diagnos|depression|anxiety|medically|always|proves/i);
  });

  it("reports only weekday patterns backed by at least three samples", async () => {
    const { env } = environment();
    const toolResult = checkinResult({
      range: { startDate: "2026-06-30", endDate: "2026-07-29" },
      weekdayPatterns: [
        { weekday: "Monday", sampleCount: 3, averageEnergy: 2.3, mostCommonMood: "tired" },
        { weekday: "Friday", sampleCount: 2, averageEnergy: 4.5, mostCommonMood: "great" },
      ],
    });
    const json = await (await worker.fetch(request(body("What days do I usually feel tired?", { toolResult })), env)).json() as any;
    expect(json.reply).toContain("Mondays appear");
    expect(json.reply).not.toContain("Friday");
    expect(json.reply).not.toMatch(/always|prove/i);
  });

  it("does not claim a trend from only two check-ins", async () => {
    const { env } = environment();
    const toolResult = checkinResult({
      totalCheckIns: 2,
      moodCounts: { great: 0, good: 0, okay: 0, tired: 1, stressed: 1, low: 0 },
      averageEnergy: 2.5,
      averageStress: 3.5,
      weekdayPatterns: [],
    });
    const json = await (await worker.fetch(request(body("How have I been feeling lately?", { toolResult })), env)).json() as any;
    expect(json.reply).toContain("not enough information to describe a trend");
  });

  it("handles no check-ins today or in the requested range", async () => {
    const { env } = environment();
    const toolResult = checkinResult({
      totalCheckIns: 0,
      currentCheckIn: null,
      moodCounts: { great: 0, good: 0, okay: 0, tired: 0, stressed: 0, low: 0 },
      averageEnergy: null,
      averageStress: null,
      weekdayPatterns: [],
    });
    const json = await (await worker.fetch(request(body("How have I been feeling lately?", { toolResult })), env)).json() as any;
    expect(json.reply).toContain("no check-ins");
    expect(json.reply).toContain("do not have enough data");
  });

  it("rejects raw private notes, invalid mood values, and invalid scores", () => {
    expect(checkinInsightsToolResultSchema.safeParse(checkinResult({ notes: ["private"] })).success).toBe(false);
    expect(checkinInsightsToolResultSchema.safeParse(checkinResult({ currentCheckIn: { date: "2026-07-29", mood: "anxious", energy: 2, stress: 3 } })).success).toBe(false);
    expect(checkinInsightsToolResultSchema.safeParse(checkinResult({ currentCheckIn: { date: "2026-07-29", mood: "tired", energy: 0, stress: 6 } })).success).toBe(false);
  });
});

describe("daily briefing", () => {
  it.each([
    ["Plan today based on how I am feeling.", "today"],
    ["Help me create a lighter week.", "this_week"],
    ["What should I focus on today?", "today"],
  ])("requests one sanitized briefing context for: %s", async (message, period) => {
    const { env, run } = environment();
    const json = await (await worker.fetch(request(body(message)), env)).json() as any;
    expect(json.toolCall).toEqual({
      name: "generate_daily_briefing",
      requiresConfirmation: false,
      arguments: { period, includeSchedule: true, includeSavingsProgress: true, includeCheckInInsights: true },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["tired", "shorter work block"],
    ["stressed", "one essential priority"],
    ["great", "focused priority"],
    ["okay", "balanced plan"],
    ["low", "small, achievable step"],
  ])("uses a safe mood-aware suggestion for %s", async (mood, expected) => {
    const { env } = environment();
    const toolResult = briefingResult({ currentCheckIn: { mood, energy: mood === "great" ? 5 : 2, stress: mood === "stressed" ? 5 : 3 } });
    const json = await (await worker.fetch(request(body("Plan today based on how I am feeling.", { toolResult })), env)).json() as any;
    expect(json.reply).toContain("Good morning, Praanshu");
    expect(json.reply).toContain("1 event");
    expect(json.reply).toContain("Submit Assignment");
    expect(json.reply).toContain(expected);
    expect(json.reply).toContain("New iPhone is 25% complete");
    expect(json.reply).not.toMatch(/diagnos|depression|anxiety|automatically|cancel/i);
  });

  it("handles an empty day without inventing offline data", async () => {
    const { env } = environment();
    const toolResult = briefingResult({
      currentCheckIn: null,
      today: { events: [], tasks: [], overdueTasks: [] },
      week: { eventCount: 0, taskCount: 0, busiestDay: null, openDays: [] },
      featuredSavingsGoal: null,
      recentCheckInInsights: null,
    });
    const json = await (await worker.fetch(request(body("What should I focus on today?", { toolResult })), env)).json() as any;
    expect(json.reply).toContain("open today");
    expect(json.reply).toContain("choose one useful priority");
    expect(json.reply).not.toContain("New iPhone");
  });

  it("returns a normal message after one result and never repeats the tool call", async () => {
    const { env, run } = environment();
    const json = await (await worker.fetch(request(body("What should I focus on today?", { toolResult: briefingResult() })), env)).json() as any;
    expect(json.type).toBe("message");
    expect(json.toolCall).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a result that does not match the requested read tool", async () => {
    const { env } = environment();
    const response = await worker.fetch(request(body("How are my savings looking?", { toolResult: checkinResult() })), env);
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "Kairo could not safely interpret that request." });
  });

  it("strictly rejects IDs, private notes, invalid dates, excessive records, and inconsistent progress", () => {
    expect(dailyBriefingToolResultSchema.safeParse(briefingResult({ userId: "private" })).success).toBe(false);
    expect(dailyBriefingToolResultSchema.safeParse(briefingResult({ currentCheckIn: { mood: "tired", energy: 2, stress: 3, note: "private" } })).success).toBe(false);
    expect(dailyBriefingToolResultSchema.safeParse(briefingResult({ localDate: "July 29" })).success).toBe(false);
    expect(dailyBriefingToolResultSchema.safeParse(briefingResult({ today: { events: [], tasks: Array.from({ length: 41 }, (_, index) => ({ title: `Task ${index}`, dueDate: null, dueTime: null, priority: "low", estimatedMinutes: null })), overdueTasks: [] } })).success).toBe(false);
    expect(savingsProgressToolResultSchema.safeParse({ name: "read_savings_progress", goals: [iphoneGoal({ progressPercent: 101 })] }).success).toBe(false);
  });
});
