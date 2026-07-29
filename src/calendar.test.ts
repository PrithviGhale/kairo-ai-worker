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

  it("keeps Enzo as a person while correcting dictated and Enzo as and ends in a time range", () => {
    expect(extractEventHints("Dinner with Enzo tomorrow around 8 PM", currentDate, timezone).title).toBe("Dinner with Enzo");
    expect(extractTimeRange("Concert starts at like 8 PM and Enzo around like 12 AM")).toMatchObject({ startTime: "20:00", endTime: "00:00", crossesMidnight: true });
  });

  it.each(["at 9 AM and ends at 12 PM", "starts at 9 AM and ends at 12 PM", "at 9 AM and it finishes at 12 PM"])("extracts a naturally stated ending from %s", (input) => {
    expect(extractTimeRange(input)).toEqual({ startTime: "09:00", endTime: "12:00", durationMinutes: 180, crossesMidnight: false });
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
    ["So I have a formula game to watch tomorrow at 9 AM and ends at 12 PM. Can you add that to my calendar?", "Formula 1 Race"],
    ["cna u add the f1 belgium grand prx for sunday at 9-11am", "Formula 1 Belgian Grand Prix"],
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

  it.each([
    ["two days from today", "2026-07-19"],
    ["2 days from now", "2026-07-19"],
    ["in three days", "2026-07-20"],
    ["a week from today", "2026-07-24"],
    ["one week from tomorrow", "2026-07-25"],
    ["a couple days after today", "2026-07-19"],
  ])("resolves the relative expression %s", (expression, expected) => {
    expect(resolveDateExpression(expression, currentDate, timezone)).toBe(expected);
  });

  it("does not let today override an offset from today", () => {
    expect(resolveDateExpression("game two days from today", currentDate, timezone)).toBe("2026-07-19");
  });

  it("extracts the complete Formula 1 event without repeating the title or asking for duration", () => {
    expect(extractEventHints("So I have a formula game to watch tomorrow at 9 AM and ends at 12 PM. Can you add that to my calendar?", "2026-07-25T15:42:00.000Z", timezone)).toMatchObject({
      title: "Formula 1 Race",
      date: "2026-07-26",
      startTime: "09:00",
      endTime: "12:00",
      durationMinutes: 180,
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

  it.each([
    ["Dentist appointment this Tuesday from 10:30 AM to 11:15 AM. Add it to the calendar.", "Dentist Appointment", "2026-07-28", "10:30", "11:15"],
    ["Block tomorrow 6:20 PM to 7:05 PM for piano lesson.", "Piano Lesson", "2026-07-26", "18:20", "19:05"],
    ["Movie night Friday starts at 8 PM and finishes at 10:30 PM.", "Movie Night", "2026-07-31", "20:00", "22:30"],
    ["Lakers vs Celtics Sunday, tip-off at 3 PM and it should be over by 5:30 PM.", "Lakers vs. Celtics", "2026-07-26", "15:00", "17:30"],
    ["Chemistry lab Thursday from 1:15 PM until 3:45 PM.", "Chemistry Lab", "2026-07-30", "13:15", "15:45"],
    ["Call with Jordan tomorrow at 9:40 AM for 35 minutes.", "Call with Jordan", "2026-07-26", "09:40", "10:15"],
    ["Brunch with Maya Saturday from noon to 1:30 PM.", "Brunch with Maya", "2026-07-25", "12:00", "13:30"],
    ["Team sync Wednesday from 14:00 to 15:15.", "Team Sync", "2026-07-29", "14:00", "15:15"],
    ["Dinner tomorrow around 7:30 PM for an hour.", "Dinner", "2026-07-26", "19:30", "20:30"],
    ["Yoga class next Monday from 7 AM to 8 AM.", "Yoga Class", "2026-08-03", "07:00", "08:00"],
    ["Schedule the race tomorrow beginning at 9 AM and wrapping up at noon.", "Race", "2026-07-26", "09:00", "12:00"],
    ["I have a basketball game two days from today between 2 PM and 4 PM. Put it on my calendar.", "Basketball Game", "2026-07-27", "14:00", "16:00"],
    ["Please put my dentist appointment in three days from 9:15 AM until 10 AM.", "Dentist Appointment", "2026-07-28", "09:15", "10:00"],
    ["There's a chemistry review a week from tomorrow at half past 5 PM for 90 minutes.", "Chemistry Review", "2026-08-02", "17:30", "19:00"],
    ["I've got football practice this coming Wednesday from 4 PM to 6 PM.", "Football Practice", "2026-07-29", "16:00", "18:00"],
    ["Coffee with Sam the day after tomorrow at quarter to 4 PM for half an hour.", "Coffee with Sam", "2026-07-27", "15:45", "16:15"],
    ["Block team retro two days from now between 14:00 and 15:30.", "Team Retro", "2026-07-27", "14:00", "15:30"],
    ["Schedule deployment tonight at 11 PM for an hour and a half.", "Deployment", "2026-07-25", "23:00", "00:30"],
    ["I have a soccer match 2 days from today at 7 PM and it ends at 9:15 PM.", "Soccer Match", "2026-07-27", "19:00", "21:15"],
    ["Schedule pickup soccer Saturday at 1 PM for two hours and a half.", "Pickup Soccer", "2026-07-25", "13:00", "15:30"],
    ["Add lunch with Priya tomorrow at noon for 45 minutes.", "Lunch with Priya", "2026-07-26", "12:00", "12:45"],
    ["My sister's graduation July 30th from 6 PM to 8 PM.", "Sister's Graduation", "2026-07-30", "18:00", "20:00"],
    ["Block a workout in two weeks at 6:15 AM for 75 mins.", "Workout", "2026-08-08", "06:15", "07:30"],
    ["Add my red-eye flight in five days from 11 PM to 2 AM.", "Red-Eye Flight", "2026-07-30", "23:00", "02:00"],
    ["Vet appointment this coming Tuesday at quarter past 8 AM for 45 minutes.", "Vet Appointment", "2026-07-28", "08:15", "09:00"],
    ["To have a BTS concert next week at August 6 it starts at like 8 PM and Enzo around like 12 AM. Can you add that to my calendar?", "BTS Concert", "2026-08-06", "20:00", "00:00"],
    ["So I have a BTS concert coming up at August 6. Can you add that to my calendar? It starts at around 6 PM and at 12 AM.", "BTS Concert", "2026-08-06", "18:00", "00:00"],
  ])("passes the natural-language evaluation: %s", (message, title, date, startTime, endTime) => {
    expect(extractEventHints(message, "2026-07-25T15:45:00.000Z", timezone)).toMatchObject({ title, date, startTime, endTime });
  });
});
