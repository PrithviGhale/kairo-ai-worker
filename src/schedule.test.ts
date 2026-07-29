import { describe, expect, it } from "vitest";

import { MAX_SCHEDULE_RECORDS, scheduleToolResultSchema, type ScheduleToolResult } from "./assistant-v2-schemas";
import { dateFromRecentScheduleRange, resolveScheduleQuestion, summarizeSchedule } from "./schedule";

const currentDate = "2026-07-29T14:00:00-04:00";
const timezone = "America/New_York";
const emptyResult = (overrides: Partial<ScheduleToolResult> = {}): ScheduleToolResult => ({
  name: "answer_schedule_question",
  range: { startDate: "2026-08-03", endDate: "2026-08-09", rangeLabel: "next week" },
  events: [], tasks: [], goalDeadlines: [], ...overrides,
});

describe("schedule range resolution", () => {
  it.each([
    ["What does my schedule look like this week?", "2026-07-27", "2026-08-02", "this week"],
    ["What do I have next week?", "2026-08-03", "2026-08-09", "next week"],
    ["What is planned for the week of August 17?", "2026-08-17", "2026-08-23", "the week of August 17"],
    ["How busy am I this weekend?", "2026-08-01", "2026-08-02", "this weekend"],
    ["What do I have over the next seven days?", "2026-07-29", "2026-08-04", "the next seven days"],
    ["What is planned August 17 through August 23?", "2026-08-17", "2026-08-23", "August 17 through August 23"],
    ["What am I doing tomorrow?", "2026-07-30", "2026-07-30", "tomorrow"],
    ["What do I have today?", "2026-07-29", "2026-07-29", "today"],
    ["What do I have next month?", "2026-08-01", "2026-08-31", "next month"],
    ["What do I have August 17?", "2026-08-17", "2026-08-17", "August 17"],
    ["What do I have coming up?", "2026-07-29", "2026-08-27", "the next 30 days"],
  ])("resolves %s", (message, startDate, endDate, rangeLabel) => {
    expect(resolveScheduleQuestion(message, currentDate, timezone)).toMatchObject({ startDate, endDate, rangeLabel, includeCompletedTasks: false });
  });

  it("uses the supplied Sunday week-start preference", () => {
    expect(resolveScheduleQuestion("What does my schedule look like this week?", currentDate, timezone, "sunday")).toMatchObject({ startDate: "2026-07-26", endDate: "2026-08-01" });
  });

  it("resolves a following-week question from recent schedule context", () => {
    const history = [
      { role: "user" as const, content: "What do I have next week?" },
      { role: "assistant" as const, content: "Schedule: August 3, 2026 through August 9, 2026" },
    ];
    expect(resolveScheduleQuestion("What about the next week?", currentDate, timezone, "monday", history)).toMatchObject({ startDate: "2026-08-10", endDate: "2026-08-16", rangeLabel: "the following week" });
  });

  it("resolves a bare weekday against the prior schedule range", () => {
    const history = [{ role: "user" as const, content: "What do I have next week?" }, { role: "assistant" as const, content: "Schedule: August 3 through August 9" }];
    expect(dateFromRecentScheduleRange("Add something Friday at 6 PM", currentDate, timezone, "monday", history)).toBe("2026-08-07");
    expect(dateFromRecentScheduleRange("Add something next Friday at 6 PM", currentDate, timezone, "monday", history)).toBeNull();
  });

  it.each([
    ["When am I free this week?", "availability"],
    ["Help me plan around everything I have next week.", "planning"],
    ["What is my busiest day this week?", "busiest_day"],
    ["What do I have coming up?", "upcoming"],
  ])("classifies %s as %s", (message, questionType) => {
    expect(resolveScheduleQuestion(message, currentDate, timezone)?.questionType).toBe(questionType);
  });
});

describe("grounded schedule summaries", () => {
  it("returns the natural empty-range response", () => {
    expect(summarizeSchedule(emptyResult(), currentDate, timezone)).toBe("Your schedule is currently open from August 3, 2026 through August 9, 2026. Would you like to add anything or create a plan for the week?");
  });

  it("orders all-day events before timed events and preserves overnight ranges", () => {
    const summary = summarizeSchedule(emptyResult({ events: [
      { title: "Late Flight", date: "2026-08-04", startTime: "23:00", endTime: "02:00", allDay: false, location: null },
      { title: "Conference", date: "2026-08-04", startTime: null, endTime: null, allDay: true, location: "Hall A" },
      { title: "Dentist Appointment", date: "2026-08-04", startTime: "14:00", endTime: "15:00", allDay: false, location: null },
    ] }), currentDate, timezone);
    expect(summary.indexOf("All day: Conference")).toBeLessThan(summary.indexOf("2:00 PM–3:00 PM: Dentist Appointment"));
    expect(summary).toContain("11:00 PM–2:00 AM (overnight): Late Flight");
  });

  it("lists incomplete due tasks and excludes completed tasks", () => {
    const summary = summarizeSchedule(emptyResult({ tasks: [
      { title: "Complete Database Assignment", dueDate: "2026-08-06", dueTime: "20:00", priority: "high", estimatedMinutes: 180, completed: false },
      { title: "Already Finished", dueDate: "2026-08-06", dueTime: null, priority: "low", estimatedMinutes: 15, completed: true },
    ] }), currentDate, timezone);
    expect(summary).toContain("Complete Database Assignment");
    expect(summary).toContain("est. 3 hours");
    expect(summary).not.toContain("Already Finished");
  });

  it("puts overdue tasks in a separate warning section", () => {
    const summary = summarizeSchedule(emptyResult({ tasks: [
      { title: "Submit Lab", dueDate: "2026-07-28", dueTime: "17:00", priority: "critical", estimatedMinutes: 60, completed: false },
    ] }), currentDate, timezone);
    expect(summary).toContain("Overdue:");
    expect(summary).toContain("Submit Lab — due July 28, 2026 at 5:00 PM · critical priority");
  });

  it("identifies the busiest day and overlapping events", () => {
    const summary = summarizeSchedule(emptyResult({ events: [
      { title: "Workshop", date: "2026-08-04", startTime: "09:00", endTime: "12:00", allDay: false, location: null },
      { title: "Team Call", date: "2026-08-04", startTime: "11:30", endTime: "12:30", allDay: false, location: null },
      { title: "Coffee", date: "2026-08-05", startTime: "10:00", endTime: "10:30", allDay: false, location: null },
    ] }), currentDate, timezone);
    expect(summary).toContain("Workshop overlaps Team Call");
    expect(summary).toContain("Busiest day: Tuesday");
  });

  it("suggests an open supplied day for a three-hour task without inventing free time", () => {
    const summary = summarizeSchedule(emptyResult({
      events: [{ title: "Dentist Appointment", date: "2026-08-04", startTime: "14:00", endTime: "15:00", allDay: false, location: null }],
      tasks: [{ title: "Complete Database Assignment", dueDate: "2026-08-06", dueTime: "20:00", priority: "high", estimatedMinutes: 180, completed: false }],
    }), currentDate, timezone);
    expect(summary).toContain("Monday has no supplied conflicts and could hold Complete Database Assignment (3 hours)");
    expect(summary).toContain("do not guarantee availability");
    expect(summary.toLowerCase()).not.toContain("you are free");
    expect(summary).toContain("No matching work block");
  });

  it("suggests an exact task window only when supplied events establish the gap", () => {
    const summary = summarizeSchedule(emptyResult({
      events: [
        { title: "Morning Class", date: "2026-08-04", startTime: "09:00", endTime: "10:00", allDay: false, location: null },
        { title: "Evening Class", date: "2026-08-04", startTime: "14:00", endTime: "15:00", allDay: false, location: null },
      ],
      tasks: [{ title: "Complete Database Assignment", dueDate: "2026-08-04", dueTime: "20:00", priority: "high", estimatedMinutes: 180, completed: false }],
      goalDeadlines: [3, 5, 6, 7, 8, 9].map((day) => ({ title: `Daily Goal ${day}`, targetDate: `2026-08-0${day}` })),
    }), currentDate, timezone);
    expect(summary).toContain("supplied gap on Tuesday from 10:00 AM to 2:00 PM could fit Complete Database Assignment (3 hours)");
  });
});

describe("schedule tool-result validation", () => {
  it("accepts strict, ID-free schedule records", () => {
    expect(scheduleToolResultSchema.safeParse(emptyResult({
      events: [{ title: "Dentist", date: "2026-08-04", startTime: "14:00", endTime: "15:00", allDay: false, location: null }],
      tasks: [{ title: "Assignment", dueDate: "2026-08-06", dueTime: null, priority: "high", estimatedMinutes: 180, completed: false }],
      goalDeadlines: [{ title: "Trip Fund", targetDate: "2026-08-09" }],
    })).success).toBe(true);
  });

  it.each([
    ["private database ID", { events: [{ title: "Dentist", date: "2026-08-04", startTime: "14:00", endTime: "15:00", allDay: false, location: null, id: "private" }] }],
    ["invalid time", { events: [{ title: "Dentist", date: "2026-08-04", startTime: "25:00", endTime: null, allDay: false, location: null }] }],
    ["unknown priority", { tasks: [{ title: "Assignment", dueDate: "2026-08-06", dueTime: null, priority: "urgent", estimatedMinutes: 180, completed: false }] }],
    ["unexpected private notes", { tasks: [{ title: "Assignment", dueDate: "2026-08-06", dueTime: null, priority: "high", estimatedMinutes: 180, completed: false, notes: "private" }] }],
  ])("rejects %s", (_label, overrides) => {
    expect(scheduleToolResultSchema.safeParse(emptyResult(overrides as Partial<ScheduleToolResult>)).success).toBe(false);
  });

  it("rejects an excessive date range", () => {
    expect(scheduleToolResultSchema.safeParse(emptyResult({ range: { startDate: "2026-01-01", endDate: "2026-04-01", rangeLabel: "too long" } })).success).toBe(false);
  });

  it("rejects excessive supplied records", () => {
    const events = Array.from({ length: MAX_SCHEDULE_RECORDS + 1 }, (_, index) => ({ title: `Event ${index}`, date: "2026-08-04", startTime: "14:00", endTime: "15:00", allDay: false, location: null }));
    expect(scheduleToolResultSchema.safeParse(emptyResult({ events })).success).toBe(false);
  });
});
