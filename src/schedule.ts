import type { ChatMessage } from "./types";
import type { ScheduleQuestionArguments, ScheduleToolResult } from "./assistant-v2-schemas";

const DAY_MS = 86_400_000;
const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"] as const;
const weekdayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const monthPattern = monthNames.join("|");

const parseDay = (value: string) => new Date(`${value}T00:00:00.000Z`);
const formatDay = (value: Date) => value.toISOString().slice(0, 10);
const addDays = (value: string, amount: number) => formatDay(new Date(parseDay(value).getTime() + amount * DAY_MS));
const dayDifference = (start: string, end: string) => Math.round((parseDay(end).getTime() - parseDay(start).getTime()) / DAY_MS);

const localDateInTimezone = (currentDate: string, timezone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(currentDate));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
};

const startOfWeek = (date: string, weekStartsOn: "monday" | "sunday") => {
  const weekday = parseDay(date).getUTCDay();
  const start = weekStartsOn === "monday" ? 1 : 0;
  return addDays(date, -((weekday - start + 7) % 7));
};

const monthBoundary = (date: string, offset: number) => {
  const source = parseDay(date);
  const first = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + offset, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  return { startDate: formatDay(first), endDate: formatDay(last) };
};

const absoluteDate = (monthName: string, dayText: string, yearText: string | undefined, today: string) => {
  const month = monthNames.indexOf(monthName.toLowerCase() as typeof monthNames[number]);
  const day = Number(dayText);
  let year = yearText ? Number(yearText) : parseDay(today).getUTCFullYear();
  let candidate = new Date(Date.UTC(year, month, day));
  if (candidate.getUTCMonth() !== month || candidate.getUTCDate() !== day) return null;
  if (!yearText && formatDay(candidate) < today) candidate = new Date(Date.UTC(++year, month, day));
  return formatDay(candidate);
};

const upcomingWeekday = (today: string, weekday: number, explicitlyNext: boolean) => {
  const current = parseDay(today).getUTCDay();
  let offset = (weekday - current + 7) % 7;
  if (explicitlyNext) offset += 7;
  return addDays(today, offset);
};

const exactRangeFromMessage = (message: string, today: string) => {
  const match = message.match(new RegExp(`\\b(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\s+(?:through|to|until|-)\\s+(?:(${monthPattern})\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "i"));
  if (!match) return null;
  const startDate = absoluteDate(match[1], match[2], match[3], today);
  if (!startDate) return null;
  const endDate = absoluteDate(match[4] ?? match[1], match[5], match[6] ?? match[3], startDate);
  if (!endDate || endDate < startDate) return null;
  return { startDate, endDate };
};

const lastScheduleQuestion = (history: ChatMessage[]): ChatMessage | undefined => [...history].reverse().find((item) => item.role === "user" && isScheduleQuestion(item.content, [], false));

export const isScheduleQuestion = (message: string, history: ChatMessage[] = [], allowContext = true): boolean => {
  const text = message.trim();
  if (/\b(?:add|create|block|move|reschedule|remove|delete|cancel)\b/i.test(text) && !/\b(?:what|when|how|do i have|am i)\b/i.test(text)) return false;
  if (/\b(?:what (?:does|do|is|am)\b[\s\S]*(?:schedule|planned|doing|have)|what do i have|what am i doing|what is planned|coming up|upcoming|when am i free|how busy|busiest day|do i have time|plan around everything|review my (?:week|schedule)|show (?:me |my )?(?:this week|next week|week|schedule)|summari[sz]e (?:my |this |next )?(?:week|schedule)|check my schedule|help me plan (?:my |this |next )?(?:week|day))\b/i.test(text)) return true;
  return allowContext && /\bwhat about (?:the )?(?:next|following) week\b/i.test(text) && Boolean(lastScheduleQuestion(history));
};

const questionTypeFor = (message: string, startDate: string, endDate: string): ScheduleQuestionArguments["questionType"] => {
  if (/\bbusiest\s+day\b/i.test(message)) return "busiest_day";
  if (/\b(?:when am i free|availability|do i have time|when can i)\b/i.test(message)) return "availability";
  if (/\b(?:help me plan|plan around|organize around)\b/i.test(message)) return "planning";
  if (/\b(?:upcoming|coming up)\b/i.test(message)) return "upcoming";
  const length = dayDifference(startDate, endDate) + 1;
  if (length === 1) return "daily_overview";
  if (length === 7) return "weekly_overview";
  return "range_overview";
};

export const resolveScheduleQuestion = (
  message: string,
  currentDate: string,
  timezone: string,
  weekStartsOn: "monday" | "sunday" = "monday",
  history: ChatMessage[] = [],
): ScheduleQuestionArguments | null => {
  if (!isScheduleQuestion(message, history)) return null;
  const text = message.toLowerCase();
  const today = localDateInTimezone(currentDate, timezone);
  let startDate: string;
  let endDate: string;
  let rangeLabel: string;

  const contextualNext = /\bwhat about (?:the )?(?:next|following) week\b/i.test(message) ? lastScheduleQuestion(history) : undefined;
  if (contextualNext) {
    const previous = resolveScheduleQuestion(contextualNext.content, currentDate, timezone, weekStartsOn, []);
    if (previous) {
      startDate = addDays(previous.startDate, 7);
      endDate = addDays(previous.endDate, 7);
      rangeLabel = "the following week";
      return {
        questionType: questionTypeFor(message, startDate, endDate), startDate, endDate, rangeLabel,
        includeEvents: true, includeTasks: true, includeGoalDeadlines: true, includeCompletedTasks: false,
      };
    }
  }

  const exactRange = exactRangeFromMessage(message, today);
  const weekOf = message.match(new RegExp(`\\bweek of (${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, "i"));
  const absolute = message.match(new RegExp(`\\b(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "i"));

  if (exactRange) {
    ({ startDate, endDate } = exactRange);
    rangeLabel = `${message.match(new RegExp(`(${monthPattern})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\s+(?:through|to|until|-)\\s+(?:(?:${monthPattern})\\s+)?\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?`, "i"))?.[0] ?? "the requested range"}`;
  } else if (/\bnext seven days\b|\bnext 7 days\b/i.test(message)) {
    startDate = today; endDate = addDays(today, 6); rangeLabel = "the next seven days";
  } else if (/\bnext weekend\b/i.test(message)) {
    const weekday = parseDay(today).getUTCDay();
    const thisSaturday = addDays(today, weekday === 0 ? -1 : (6 - weekday + 7) % 7);
    startDate = addDays(thisSaturday, 7); endDate = addDays(startDate, 1); rangeLabel = "next weekend";
  } else if (/\bthis weekend\b|\bthe weekend\b/i.test(message)) {
    const weekday = parseDay(today).getUTCDay();
    startDate = addDays(today, weekday === 0 ? -1 : (6 - weekday + 7) % 7); endDate = addDays(startDate, 1); rangeLabel = "this weekend";
  } else if (/\bnext month\b/i.test(message)) {
    ({ startDate, endDate } = monthBoundary(today, 1)); rangeLabel = "next month";
  } else if (/\bthis month\b/i.test(message)) {
    ({ startDate, endDate } = monthBoundary(today, 0)); rangeLabel = "this month";
  } else if (weekOf) {
    const date = absoluteDate(weekOf[1], weekOf[2], weekOf[3], today);
    if (!date) return null;
    startDate = startOfWeek(date, weekStartsOn); endDate = addDays(startDate, 6); rangeLabel = `the week of ${weekOf[1]} ${Number(weekOf[2])}`;
  } else if (/\bnext week\b/i.test(message)) {
    startDate = addDays(startOfWeek(today, weekStartsOn), 7); endDate = addDays(startDate, 6); rangeLabel = "next week";
  } else if (/\bthis week\b|\bmy week\b/i.test(message)) {
    startDate = startOfWeek(today, weekStartsOn); endDate = addDays(startDate, 6); rangeLabel = "this week";
  } else if (/\bupcoming\b|\bcoming up\b/i.test(message)) {
    startDate = today; endDate = addDays(today, 29); rangeLabel = "the next 30 days";
  } else if (/\btomorrow\b/i.test(message)) {
    startDate = addDays(today, 1); endDate = startDate; rangeLabel = "tomorrow";
  } else if (/\btoday\b/i.test(message)) {
    startDate = today; endDate = today; rangeLabel = "today";
  } else if (absolute) {
    const date = absoluteDate(absolute[1], absolute[2], absolute[3], today);
    if (!date) return null;
    startDate = date; endDate = date; rangeLabel = `${absolute[1]} ${Number(absolute[2])}`;
  } else {
    const weekdayIndex = weekdayNames.findIndex((weekday) => new RegExp(`\\b(?:this\\s+|next\\s+)?${weekday}\\b`, "i").test(message));
    if (weekdayIndex >= 0) {
      const explicitlyNext = new RegExp(`\\bnext\\s+${weekdayNames[weekdayIndex]}\\b`, "i").test(message);
      startDate = upcomingWeekday(today, weekdayIndex, explicitlyNext); endDate = startDate; rangeLabel = weekdayNames[weekdayIndex];
    } else {
      startDate = today; endDate = addDays(today, 6); rangeLabel = "the next seven days";
    }
  }

  return {
    questionType: questionTypeFor(message, startDate, endDate), startDate, endDate, rangeLabel,
    includeEvents: true, includeTasks: true, includeGoalDeadlines: true, includeCompletedTasks: false,
  };
};

export const dateFromRecentScheduleRange = (
  message: string,
  currentDate: string,
  timezone: string,
  weekStartsOn: "monday" | "sunday",
  history: ChatMessage[],
) => {
  const weekdayIndex = weekdayNames.findIndex((weekday) => new RegExp(`\\b${weekday}\\b`, "i").test(message));
  if (weekdayIndex < 0 || new RegExp(`\\b(?:this|next)\\s+${weekdayNames[weekdayIndex]}\\b`, "i").test(message)) return null;
  const previous = lastScheduleQuestion(history);
  if (!previous) return null;
  const range = resolveScheduleQuestion(previous.content, currentDate, timezone, weekStartsOn, []);
  if (!range) return null;
  const matches: string[] = [];
  for (let date = range.startDate; date <= range.endDate; date = addDays(date, 1)) if (parseDay(date).getUTCDay() === weekdayIndex) matches.push(date);
  return matches.length === 1 ? matches[0] : null;
};

const prettyDate = (date: string, weekday = false) => new Intl.DateTimeFormat("en-US", weekday
  ? { timeZone: "UTC", weekday: "long" }
  : { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" }).format(parseDay(date));
const prettyRange = (startDate: string, endDate: string) => startDate === endDate ? prettyDate(startDate) : `${prettyDate(startDate)} through ${prettyDate(endDate)}`;
const prettyTime = (time: string) => {
  const hour = Number(time.slice(0, 2));
  return `${hour % 12 || 12}:${time.slice(3, 5)} ${hour >= 12 ? "PM" : "AM"}`;
};
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const durationText = (value: number) => value % 60 === 0 ? `${value / 60} hour${value === 60 ? "" : "s"}` : `${value} minutes`;

type DayLine = { order: number; text: string };

const eventBounds = (event: ScheduleToolResult["events"][number]) => {
  if (event.allDay || !event.startTime) return null;
  const start = parseDay(event.date).getTime() / DAY_MS * 1_440 + minutes(event.startTime);
  if (!event.endTime) return { start, end: start + 1 };
  let end = parseDay(event.date).getTime() / DAY_MS * 1_440 + minutes(event.endTime);
  if (end <= start) end += 1_440;
  return { start, end };
};

const overlapWarnings = (events: ScheduleToolResult["events"]) => {
  const timed = events.flatMap((event) => {
    const bounds = eventBounds(event);
    return bounds ? [{ event, ...bounds }] : [];
  }).sort((a, b) => a.start - b.start);
  const warnings: string[] = [];
  for (let index = 0; index < timed.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < timed.length && timed[otherIndex].start < timed[index].end; otherIndex += 1) {
      warnings.push(`${timed[index].event.title} overlaps ${timed[otherIndex].event.title}`);
    }
  }
  return warnings;
};

const busyMinutes = (events: ScheduleToolResult["events"]) => {
  const totals = new Map<string, number>();
  for (const event of events) {
    if (event.allDay) { totals.set(event.date, (totals.get(event.date) ?? 0) + 1_440); continue; }
    if (!event.startTime) continue;
    const start = minutes(event.startTime);
    if (!event.endTime) { totals.set(event.date, (totals.get(event.date) ?? 0) + 1); continue; }
    const end = minutes(event.endTime);
    if (end > start) totals.set(event.date, (totals.get(event.date) ?? 0) + end - start);
    else {
      totals.set(event.date, (totals.get(event.date) ?? 0) + 1_440 - start);
      const nextDate = addDays(event.date, 1);
      totals.set(nextDate, (totals.get(nextDate) ?? 0) + end);
    }
  }
  return totals;
};

const capSummary = (lines: string[]) => {
  const closing = "Would you like me to add something, move anything, or block time for a task?";
  const selected: string[] = [];
  for (const line of lines) {
    if ([...selected, line, closing].join("\n").length > 5_800) break;
    selected.push(line);
  }
  return [...selected, closing].join("\n");
};

export const summarizeSchedule = (result: ScheduleToolResult, currentDate: string, timezone: string) => {
  const today = localDateInTimezone(currentDate, timezone);
  const events = [...result.events].sort((a, b) => a.date.localeCompare(b.date) || Number(b.allDay) - Number(a.allDay) || (a.startTime ?? "").localeCompare(b.startTime ?? ""));
  const incompleteTasks = result.tasks.filter((task) => !task.completed);
  const overdue = incompleteTasks.filter((task) => task.dueDate < today).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || (a.dueTime ?? "").localeCompare(b.dueTime ?? ""));
  const dueTasks = incompleteTasks.filter((task) => task.dueDate >= today && task.dueDate >= result.range.startDate && task.dueDate <= result.range.endDate);
  const goals = [...result.goalDeadlines].sort((a, b) => a.targetDate.localeCompare(b.targetDate));

  if (!events.length && !dueTasks.length && !overdue.length && !goals.length) {
    return `Your schedule is currently open from ${prettyRange(result.range.startDate, result.range.endDate)}. Would you like to add anything or create a plan for the week?`;
  }

  const byDate = new Map<string, DayLine[]>();
  const push = (date: string, line: DayLine) => byDate.set(date, [...(byDate.get(date) ?? []), line]);
  for (const event of events) {
    const location = event.location ? ` · ${event.location}` : "";
    if (event.allDay) push(event.date, { order: 0, text: `- All day: ${event.title}${location}` });
    else {
      const time = event.startTime ? prettyTime(event.startTime) : "Time not supplied";
      const range = event.endTime ? `${time}–${prettyTime(event.endTime)}${minutes(event.endTime) <= minutes(event.startTime!) ? " (overnight)" : ""}` : time;
      push(event.date, { order: 100 + (event.startTime ? minutes(event.startTime) : 0), text: `- ${range}: ${event.title}${location}` });
    }
  }
  for (const task of dueTasks) {
    const time = task.dueTime ? ` at ${prettyTime(task.dueTime)}` : "";
    const estimate = task.estimatedMinutes ? ` · est. ${durationText(task.estimatedMinutes)}` : "";
    push(task.dueDate, { order: task.dueTime ? 100 + minutes(task.dueTime) : 1_600, text: `- Task due${time}: ${task.title} · ${task.priority} priority${estimate}` });
  }
  for (const goal of goals) push(goal.targetDate, { order: 1_700, text: `- Goal deadline: ${goal.title}` });

  const lines = [`Schedule: ${prettyRange(result.range.startDate, result.range.endDate)}`];
  for (const date of [...byDate.keys()].sort()) {
    lines.push("", `${prettyDate(date, true)}, ${prettyDate(date)}`);
    lines.push(...(byDate.get(date) ?? []).sort((a, b) => a.order - b.order || a.text.localeCompare(b.text)).map((item) => item.text));
  }

  if (overdue.length) {
    lines.push("", "Overdue:");
    for (const task of overdue) lines.push(`- ${task.title} — due ${prettyDate(task.dueDate)}${task.dueTime ? ` at ${prettyTime(task.dueTime)}` : ""} · ${task.priority} priority`);
  }

  const overlaps = overlapWarnings(events);
  if (overlaps.length) lines.push("", `Conflicts: ${overlaps.join("; ")}.`);

  const totals = busyMinutes(events);
  const busiest = [...totals.entries()].filter(([date]) => date >= result.range.startDate && date <= result.range.endDate).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (busiest) lines.push("", `Busiest day: ${prettyDate(busiest[0], true)} has the most supplied scheduled time (${durationText(busiest[1])}).`);

  const occupiedDates = new Set([...events.map((event) => event.date), ...dueTasks.map((task) => task.dueDate), ...goals.map((goal) => goal.targetDate)]);
  const openDates: string[] = [];
  for (let date = result.range.startDate; date <= result.range.endDate; date = addDays(date, 1)) if (!occupiedDates.has(date)) openDates.push(date);
  if (openDates.length) {
    const shown = openDates.slice(0, 3).map((date) => prettyDate(date, true));
    lines.push("", `Lighter days: no supplied items are listed for ${shown.join(", ")}${openDates.length > shown.length ? `, or ${openDates.length - shown.length} other day${openDates.length - shown.length === 1 ? "" : "s"}` : ""}.`);
  } else if (totals.size > 1) {
    const lightest = [...totals.entries()].filter(([date]) => date >= result.range.startDate && date <= result.range.endDate).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0];
    if (lightest) lines.push("", `Lighter day: ${prettyDate(lightest[0], true)} has the least supplied scheduled time.`);
  }

  const plannableTask = dueTasks.filter((task) => task.estimatedMinutes).sort((a, b) => Number(b.priority === "critical" || b.priority === "high") - Number(a.priority === "critical" || a.priority === "high") || a.dueDate.localeCompare(b.dueDate))[0];
  if (plannableTask) {
    const suggestedDate = openDates.find((date) => date <= plannableTask.dueDate);
    if (suggestedDate) lines.push("", `Planning idea: ${prettyDate(suggestedDate, true)} has no supplied conflicts and could hold ${plannableTask.title} (${durationText(plannableTask.estimatedMinutes!)}). No work time is assumed.`);
    else {
      const timedByDate = new Map<string, { start: number; end: number }[]>();
      for (const event of events) {
        if (event.allDay || !event.startTime || !event.endTime || minutes(event.endTime) <= minutes(event.startTime)) continue;
        timedByDate.set(event.date, [...(timedByDate.get(event.date) ?? []), { start: minutes(event.startTime), end: minutes(event.endTime) }]);
      }
      let groundedGap: { date: string; start: number; end: number } | undefined;
      for (const [date, intervals] of [...timedByDate.entries()].sort()) {
        if (date > plannableTask.dueDate) continue;
        const sorted = intervals.sort((a, b) => a.start - b.start);
        for (let index = 0; index < sorted.length - 1; index += 1) {
          if (sorted[index + 1].start - sorted[index].end >= plannableTask.estimatedMinutes!) {
            groundedGap = { date, start: sorted[index].end, end: sorted[index + 1].start };
            break;
          }
        }
        if (groundedGap) break;
      }
      if (groundedGap) {
        const asTime = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
        lines.push("", `Planning idea: the supplied gap on ${prettyDate(groundedGap.date, true)} from ${prettyTime(asTime(groundedGap.start))} to ${prettyTime(asTime(groundedGap.end))} could fit ${plannableTask.title} (${durationText(plannableTask.estimatedMinutes!)}).`);
      }
    }
    const taskWords = plannableTask.title.toLowerCase().match(/[a-z0-9]+/g)?.filter((word) => word.length > 3) ?? [];
    const hasWorkBlock = events.some((event) => taskWords.some((word) => event.title.toLowerCase().includes(word)));
    if (!hasWorkBlock) lines.push(`No matching work block for ${plannableTask.title} appears in the supplied schedule.`);
  }

  if (openDates.length) lines.push("Assumption: “open” and “lighter” mean no items were supplied for those dates; they do not guarantee availability.");
  return capSummary(lines);
};
