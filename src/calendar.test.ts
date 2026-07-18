import { describe, expect, it } from "vitest";

import { extractEventHints, extractTimeRange, normalizeEventTitle, normalizeTimePunctuation, resolveDateExpression } from "./calendar";

const currentDate = "2026-07-17T14:00:00.000Z";
const timezone = "America/New_York";

describe("calendar extraction helpers", () => {
  it.each([
    "3 PM till 4:45 PM",
    "3 PM until 4:45 PM",
    "3 PM to 4:45 PM",
    "from 3 PM to 4:45 PM",
    "3-4:45 PM",
    "3–4:45 PM",
    "3 — 4:45 PM",
    "3-4;45 PM",
  ])("extracts %s", (input) => {
    expect(extractTimeRange(input)).toEqual({ startTime: "15:00", endTime: "16:45", durationMinutes: 105, crossesMidnight: false });
  });

  it("normalizes only time-like semicolon punctuation and Unicode dashes", () => {
    expect(normalizeTimePunctuation("3–4;45 PM; bring snacks")).toBe("3-4:45 PM; bring snacks");
  });

  it("keeps a range without AM or PM ambiguous", () => {
    expect(extractTimeRange("3 to 4:45")).toEqual({ ambiguousRange: { startTime: "03:00", endTime: "04:45" } });
  });

  it("resolves Sunday and next Sunday from the supplied timezone date", () => {
    expect(resolveDateExpression("Sunday", currentDate, timezone)).toBe("2026-07-19");
    expect(resolveDateExpression("next Sunday", currentDate, timezone)).toBe("2026-07-26");
  });

  it.each([
    ["today", "2026-07-17"],
    ["tomorrow", "2026-07-18"],
    ["the day after tomorrow", "2026-07-19"],
    ["Friday", "2026-07-17"],
    ["next Friday", "2026-07-24"],
    ["July 25", "2026-07-25"],
    ["July 25, 2027", "2027-07-25"],
  ])("resolves %s against the supplied local date", (expression, expected) => {
    expect(resolveDateExpression(expression, currentDate, timezone)).toBe(expected);
  });

  it("does not default a missing date to today", () => {
    expect(resolveDateExpression("Add FIFA game at 3 PM", currentDate, timezone)).toBeUndefined();
  });

  it.each([
    ["Add to my calendar I have FIFA game Sunday at 3 PM till 4:45 PM", "FIFA Game"],
    ["Put dinner with Megan next Friday at 7", "Dinner with Megan"],
    ["I have an interview with Delta next Tuesday", "Delta Interview"],
    ["Remind me I need to finish my database assignment", "Complete Database Assignment"],
    ["World Cup final is Sunday, put that in my plans", "World Cup Final"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeEventTitle(input)).toBe(expected);
  });

  it("extracts the complete FIFA event without a duration follow-up", () => {
    expect(extractEventHints("Add to my calendar I have FIFA game Sunday at 3 PM till 4:45 PM", currentDate, timezone)).toMatchObject({
      title: "FIFA Game",
      date: "2026-07-19",
      startTime: "15:00",
      endTime: "16:45",
      durationMinutes: 105,
    });
  });

  it("understands noon, midnight, all-day events, and explicit durations", () => {
    expect(extractEventHints("Add lunch Sunday at noon for one hour", currentDate, timezone)).toMatchObject({
      startTime: "12:00",
      endTime: "13:00",
      durationMinutes: 60,
    });
    expect(extractEventHints("Add deployment Sunday at midnight for two hours", currentDate, timezone)).toMatchObject({
      startTime: "00:00",
      endTime: "02:00",
      durationMinutes: 120,
    });
    expect(extractEventHints("Add conference Sunday all day", currentDate, timezone)).toMatchObject({ allDay: true });
  });

  it("preserves a supplied duration while asking for an after-work start time", () => {
    expect(extractEventHints("Block one hour after work Thursday for my assignment", currentDate, timezone)).toMatchObject({
      durationMinutes: 60,
      ambiguousTimePeriod: undefined,
      startTime: undefined,
    });
  });
});
