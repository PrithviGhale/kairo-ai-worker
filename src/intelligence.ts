import type {
  CheckinInsightArguments,
  CheckinInsightsToolResult,
  DailyBriefingArguments,
  DailyBriefingToolResult,
  IntelligenceToolResult,
  SavingsProgressArguments,
  SavingsProgressToolResult,
} from "./intelligence-schemas";

export type IntelligenceToolRequest =
  | { name: "read_savings_progress"; arguments: SavingsProgressArguments }
  | { name: "read_checkin_insights"; arguments: CheckinInsightArguments }
  | { name: "generate_daily_briefing"; arguments: DailyBriefingArguments };

const cleanGoalName = (value: string | undefined) => {
  if (!value) return null;
  const cleaned = value
    .replace(/^(?:my|the)\s+/i, "")
    .replace(/\s+(?:savings?\s+)?goal$/i, "")
    .replace(/\b(?:looking|doing|progress|status)\b.*$/i, "")
    .trim();
  if (!cleaned || /^(?:savings?|goals?|active|all|current)$/i.test(cleaned)) return null;
  return cleaned.slice(0, 120);
};

const savingsGoalName = (message: string) => {
  const patterns = [
    /\bhow close (?:am i|are we) to (?:my|the)\s+(.+?)\s+(?:savings?\s+)?goal\b/i,
    /\b(?:progress|status) (?:on|of|for) (?:my|the)\s+(.+?)\s+(?:savings?\s+)?goal\b/i,
    /\bhow (?:is|are) (?:my|the)\s+(.+?)\s+(?:savings?\s+)?goal\b/i,
    /\b(?:my|the)\s+(.+?)\s+(?:savings?\s+)?goal\b/i,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    const name = cleanGoalName(match?.[1]);
    if (name) return name;
  }
  return null;
};

const checkinRange = (message: string): CheckinInsightArguments["range"] => {
  if (/\b(?:90|ninety)\s+days?\b|\b(?:last|past)\s+(?:three|3)\s+months?\b/i.test(message)) return "90_days";
  if (/\b(?:30|thirty)\s+days?\b|\b(?:last|past|this)\s+month\b/i.test(message)) return "30_days";
  if (/\b(?:14|fourteen)\s+days?\b|\b(?:last|past)\s+(?:two|2)\s+weeks?\b|\blately\b/i.test(message)) return "14_days";
  if (/\b(?:7|seven)\s+days?\b|\b(?:last|past|this)\s+week\b/i.test(message)) return "7_days";
  return /\b(?:usually|pattern|weekday|weekend|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?)\b/i.test(message) ? "30_days" : "14_days";
};

export const resolveIntelligenceRequest = (message: string): IntelligenceToolRequest | null => {
  const text = message.trim();
  if (!text) return null;

  const briefingIntent = /\b(?:daily briefing|morning briefing|brief me|what should i focus on today|what should i prioritize today|plan (?:my|the) day|plan today|organize (?:my )?day|lighter week|lighten (?:my|the) week|plan (?:my|a) week)\b/i.test(text)
    || /\b(?:today|this week)\b[\s\S]*\bbased on how i (?:feel|am feeling)\b/i.test(text);
  if (briefingIntent) {
    return {
      name: "generate_daily_briefing",
      arguments: {
        period: /\bweek\b/i.test(text) ? "this_week" : "today",
        includeSchedule: true,
        includeSavingsProgress: true,
        includeCheckInInsights: true,
      },
    };
  }

  const savingsIntent = /\b(?:how (?:are|is) (?:my )?savings|how (?:is|are) (?:my|the) .+? (?:savings? )?goal|savings? (?:looking|progress|status)|how close am i|goals? am i behind on|closest savings? goal|active savings? goals?|how much (?:more|is left|do i have left)|goal progress)\b/i.test(text);
  const savingsMutation = /\b(?:add|contribute|deposit|put|transfer)\b[\s\S]*\b(?:savings?|goal)\b/i.test(text);
  if (savingsIntent && !savingsMutation) {
    return {
      name: "read_savings_progress",
      arguments: {
        goalName: savingsGoalName(text),
        includeAllActiveGoals: true,
        includeCompletedGoals: false,
      },
    };
  }

  const checkinIntent = /\b(?:how have i been feeling|how (?:am|was) i feeling|mood insights?|mood patterns?|energy insights?|energy patterns?|check[ -]?in insights?|days? do i (?:usually )?feel|when do i (?:usually )?feel|have i been (?:tired|stressed|low)|my recent check[ -]?ins?)\b/i.test(text);
  if (checkinIntent) {
    return {
      name: "read_checkin_insights",
      arguments: {
        range: checkinRange(text),
        includeWeekdayPatterns: true,
        includeCurrentCheckIn: true,
      },
    };
  }

  return null;
};

const money = (value: number) => new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
}).format(value);

const percent = (value: number) => `${Number(value.toFixed(1))}%`;

const readableDate = (value: string) => new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
}).format(new Date(`${value}T12:00:00.000Z`));

const dayDistance = (from: string, to: string) => Math.floor((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000);

const summarizeGoal = (goal: SavingsProgressToolResult["goals"][number]) => {
  const deadline = goal.targetDate ? `, with ${money(goal.remainingAmount)} remaining before ${readableDate(goal.targetDate)}` : `, with ${money(goal.remainingAmount)} remaining`;
  return `${goal.title} is at ${money(goal.currentAmount)} of ${money(goal.targetAmount)} (${percent(goal.progressPercent)})${deadline}.`;
};

export const summarizeSavingsProgress = (result: SavingsProgressToolResult, currentDate: string, timezone: string) => {
  if (result.goals.length === 0) return "I could not find any active savings goals in the data provided by your device.";
  if (result.goals.length === 1) return summarizeGoal(result.goals[0]);

  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(currentDate));
  const closest = [...result.goals].sort((a, b) => b.progressPercent - a.progressPercent || a.remainingAmount - b.remainingAmount)[0];
  const approaching = result.goals.filter((goal) => goal.targetDate && goal.remainingAmount > 0 && dayDistance(localDate, goal.targetDate) >= 0 && dayDistance(localDate, goal.targetDate) <= 30);
  const details = result.goals.map(summarizeGoal).join(" ");
  const closestText = ` ${closest.title} is currently closest to its target.`;
  const deadlineText = approaching.length > 0
    ? ` Approaching deadlines: ${approaching.map((goal) => `${goal.title} on ${readableDate(goal.targetDate!)}`).join(", ")}.`
    : "";
  return `${details}${closestText}${deadlineText}`;
};

export const summarizeCheckinInsights = (result: CheckinInsightsToolResult) => {
  if (result.totalCheckIns === 0) {
    return result.currentCheckIn
      ? `You recorded feeling ${result.currentCheckIn.mood} today, with energy ${result.currentCheckIn.energy} of 5 and stress ${result.currentCheckIn.stress} of 5. There are not enough recent check-ins yet to describe a pattern.`
      : "There are no check-ins in this period, so I do not have enough data to describe a pattern.";
  }

  const rangeText = `${readableDate(result.range.startDate)} through ${readableDate(result.range.endDate)}`;
  const current = result.currentCheckIn
    ? ` Today you recorded feeling ${result.currentCheckIn.mood}, with energy ${result.currentCheckIn.energy} of 5 and stress ${result.currentCheckIn.stress} of 5.`
    : " There is no check-in recorded for today.";
  if (result.totalCheckIns < 3) {
    return `Based on ${result.totalCheckIns} recent check-in${result.totalCheckIns === 1 ? "" : "s"} from ${rangeText}, there is not enough information to describe a trend.${current}`;
  }

  const notableMoods = Object.entries(result.moodCounts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([mood, count]) => `${mood} ${count} time${count === 1 ? "" : "s"}`)
    .join(" and ");
  const validPatterns = result.weekdayPatterns.filter((pattern) => pattern.sampleCount >= 3);
  const patternText = validPatterns.length > 0
    ? ` Based on at least three samples per day, ${validPatterns.map((pattern) => `${pattern.weekday}s appear to average ${Number(pattern.averageEnergy.toFixed(1))} energy, with ${pattern.mostCommonMood} most often recorded`).join("; ")}.`
    : "";
  return `Based on your ${result.totalCheckIns} check-ins from ${rangeText}, you recorded ${notableMoods}. Average energy was ${Number(result.averageEnergy!.toFixed(1))} of 5 and average stress was ${Number(result.averageStress!.toFixed(1))} of 5.${current}${patternText}`;
};

const greetingFor = (currentDate: string, timezone: string) => {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(new Date(currentDate)));
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
};

const moodSuggestion = (checkin: DailyBriefingToolResult["currentCheckIn"]) => {
  if (!checkin) return "A balanced approach is to choose one meaningful task first, then reassess.";
  if (checkin.mood === "great" || checkin.mood === "good") return "Your check-in suggests useful energy for a focused priority, while still leaving some breathing room.";
  if (checkin.mood === "okay") return "A balanced plan with one meaningful priority may fit today well.";
  if (checkin.mood === "tired") return "Since you recorded lower energy, consider a shorter work block, a simple task first, and buffer time between commitments.";
  if (checkin.mood === "stressed") return "Since you recorded feeling stressed, consider choosing one essential priority and spacing optional work where your schedule allows.";
  return "Since you recorded feeling low, consider starting with one small, achievable step and keeping the rest of the plan gentle.";
};

const importantTask = (result: DailyBriefingToolResult) => {
  const overdue = result.today.overdueTasks[0];
  if (overdue) return `The most urgent item is the overdue task ${overdue.title}.`;
  const ranked = [...result.today.tasks].sort((a, b) => {
    const score = { critical: 4, high: 3, medium: 2, low: 1 } as const;
    return score[b.priority] - score[a.priority] || (a.dueTime ?? "99:99").localeCompare(b.dueTime ?? "99:99");
  });
  if (ranked[0]) return `A good first priority is ${ranked[0].title}.`;
  const event = result.today.events[0];
  if (event) return `Your first key commitment is ${event.title}${event.allDay ? " today" : ` at ${event.startTime}`}.`;
  return "You have room to choose one useful priority without crowding the day.";
};

export const summarizeDailyBriefing = (result: DailyBriefingToolResult, currentDate: string) => {
  const eventCount = result.today.events.length;
  const taskCount = result.today.tasks.length;
  const overdueCount = result.today.overdueTasks.length;
  const today = eventCount + taskCount + overdueCount === 0
    ? "Your calendar and task list are open today."
    : `You have ${eventCount} event${eventCount === 1 ? "" : "s"}, ${taskCount} task${taskCount === 1 ? "" : "s"}, and ${overdueCount} overdue task${overdueCount === 1 ? "" : "s"} in the supplied view today.`;
  const week = result.week.busiestDay
    ? ` ${result.week.busiestDay} is the busiest day in the supplied week view.`
    : result.week.openDays.length > 0 ? ` ${result.week.openDays.join(" and ")} ${result.week.openDays.length === 1 ? "is" : "are"} currently open in the supplied week view.` : "";
  const savings = result.featuredSavingsGoal
    ? ` ${result.featuredSavingsGoal.title} is ${percent(result.featuredSavingsGoal.progressPercent)} complete.`
    : "";
  return `${greetingFor(currentDate, result.timezone)}, ${result.preferredName}. ${today} ${importantTask(result)} ${moodSuggestion(result.currentCheckIn)}${week}${savings} Would you like help turning the top priority into a short plan?`;
};

export const summarizeIntelligenceResult = (result: IntelligenceToolResult, currentDate: string, timezone: string) => {
  if (result.name === "read_savings_progress") return summarizeSavingsProgress(result, currentDate, timezone);
  if (result.name === "read_checkin_insights") return summarizeCheckinInsights(result);
  return summarizeDailyBriefing(result, currentDate);
};
