import { z } from "zod";

import { localDateSchema, localTimeSchema } from "./schemas";

export const MAX_SAVINGS_GOALS = 20;
export const MAX_WEEKDAY_PATTERNS = 7;
export const MAX_DAILY_CONTEXT_RECORDS = 40;

export const moodSchema = z.enum(["great", "good", "okay", "tired", "stressed", "low"]);
export const energySchema = z.number().int().min(1).max(5);
export const stressSchema = z.number().int().min(1).max(5);
export const moneyAmountSchema = z.number().finite().nonnegative().max(1_000_000_000);
export const progressPercentSchema = z.number().finite().min(0).max(100);
export const weekdaySchema = z.enum(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);

const timezoneSchema = z.string().trim().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}, "Invalid IANA timezone.");

export const savingsProgressArgumentsSchema = z.object({
  goalName: z.string().trim().min(1).max(120).nullable(),
  includeAllActiveGoals: z.literal(true),
  includeCompletedGoals: z.literal(false),
}).strict();

export const savingsGoalProgressSchema = z.object({
  title: z.string().trim().min(1).max(120),
  targetAmount: moneyAmountSchema.positive(),
  currentAmount: moneyAmountSchema,
  remainingAmount: moneyAmountSchema,
  progressPercent: progressPercentSchema,
  targetDate: localDateSchema.nullable(),
  lastContributionDate: localDateSchema.nullable(),
}).strict().superRefine((goal, context) => {
  const expectedRemaining = Math.max(goal.targetAmount - goal.currentAmount, 0);
  const expectedPercent = Math.min((goal.currentAmount / goal.targetAmount) * 100, 100);
  if (Math.abs(goal.remainingAmount - expectedRemaining) > 0.011) {
    context.addIssue({ code: "custom", path: ["remainingAmount"], message: "Remaining amount does not match the supplied balances." });
  }
  if (Math.abs(goal.progressPercent - expectedPercent) > 0.11) {
    context.addIssue({ code: "custom", path: ["progressPercent"], message: "Progress percentage does not match the supplied balances." });
  }
});

export const savingsProgressToolResultSchema = z.object({
  name: z.literal("read_savings_progress"),
  goals: z.array(savingsGoalProgressSchema).max(MAX_SAVINGS_GOALS),
}).strict();

export const checkinInsightArgumentsSchema = z.object({
  range: z.enum(["7_days", "14_days", "30_days", "90_days"]),
  includeWeekdayPatterns: z.literal(true),
  includeCurrentCheckIn: z.literal(true),
}).strict();

const checkinRangeSchema = z.object({
  startDate: localDateSchema,
  endDate: localDateSchema,
}).strict().superRefine((range, context) => {
  const start = Date.parse(`${range.startDate}T00:00:00.000Z`);
  const end = Date.parse(`${range.endDate}T00:00:00.000Z`);
  const days = Math.floor((end - start) / 86_400_000) + 1;
  if (days < 1 || days > 90) context.addIssue({ code: "custom", path: ["endDate"], message: "Check-in range must be between 1 and 90 days." });
});

export const currentCheckinSchema = z.object({
  date: localDateSchema,
  mood: moodSchema,
  energy: energySchema,
  stress: stressSchema,
}).strict();

const moodCountsSchema = z.object({
  great: z.number().int().nonnegative().max(90),
  good: z.number().int().nonnegative().max(90),
  okay: z.number().int().nonnegative().max(90),
  tired: z.number().int().nonnegative().max(90),
  stressed: z.number().int().nonnegative().max(90),
  low: z.number().int().nonnegative().max(90),
}).strict();

export const weekdayPatternSchema = z.object({
  weekday: weekdaySchema,
  sampleCount: z.number().int().positive().max(90),
  averageEnergy: z.number().finite().min(1).max(5),
  mostCommonMood: moodSchema,
}).strict();

export const checkinInsightsToolResultSchema = z.object({
  name: z.literal("read_checkin_insights"),
  range: checkinRangeSchema,
  totalCheckIns: z.number().int().nonnegative().max(90),
  currentCheckIn: currentCheckinSchema.nullable(),
  moodCounts: moodCountsSchema,
  averageEnergy: z.number().finite().min(1).max(5).nullable(),
  averageStress: z.number().finite().min(1).max(5).nullable(),
  weekdayPatterns: z.array(weekdayPatternSchema).max(MAX_WEEKDAY_PATTERNS),
}).strict().superRefine((result, context) => {
  const moodTotal = Object.values(result.moodCounts).reduce((total, count) => total + count, 0);
  if (moodTotal !== result.totalCheckIns) context.addIssue({ code: "custom", path: ["moodCounts"], message: "Mood counts must equal total check-ins." });
  if (result.totalCheckIns === 0 && (result.averageEnergy !== null || result.averageStress !== null)) {
    context.addIssue({ code: "custom", message: "Empty check-in results cannot contain averages." });
  }
  if (result.totalCheckIns > 0 && (result.averageEnergy === null || result.averageStress === null)) {
    context.addIssue({ code: "custom", message: "Check-in averages are required when samples exist." });
  }
  if (result.currentCheckIn && (result.currentCheckIn.date < result.range.startDate || result.currentCheckIn.date > result.range.endDate)) {
    context.addIssue({ code: "custom", path: ["currentCheckIn", "date"], message: "Current check-in is outside the requested range." });
  }
  const weekdays = result.weekdayPatterns.map((pattern) => pattern.weekday);
  if (new Set(weekdays).size !== weekdays.length) context.addIssue({ code: "custom", path: ["weekdayPatterns"], message: "Weekday patterns must be unique." });
  for (const [index, pattern] of result.weekdayPatterns.entries()) {
    if (pattern.sampleCount > result.totalCheckIns) context.addIssue({ code: "custom", path: ["weekdayPatterns", index, "sampleCount"], message: "Pattern sample count exceeds total check-ins." });
  }
});

export const dailyBriefingArgumentsSchema = z.object({
  period: z.enum(["today", "this_week"]),
  includeSchedule: z.literal(true),
  includeSavingsProgress: z.literal(true),
  includeCheckInInsights: z.literal(true),
}).strict();

const briefingCheckinSchema = z.object({ mood: moodSchema, energy: energySchema, stress: stressSchema }).strict();
const briefingEventSchema = z.object({
  title: z.string().trim().min(1).max(120),
  startTime: localTimeSchema.nullable(),
  endTime: localTimeSchema.nullable(),
  allDay: z.boolean(),
}).strict().superRefine((event, context) => {
  if (event.allDay && (event.startTime !== null || event.endTime !== null)) context.addIssue({ code: "custom", message: "All-day events cannot contain times." });
  if (!event.allDay && event.startTime === null) context.addIssue({ code: "custom", path: ["startTime"], message: "Timed events require a start time." });
});
const briefingTaskSchema = z.object({
  title: z.string().trim().min(1).max(120),
  dueDate: localDateSchema.nullable(),
  dueTime: localTimeSchema.nullable(),
  priority: z.enum(["low", "medium", "high", "critical"]),
  estimatedMinutes: z.number().int().positive().max(10_080).nullable(),
}).strict().superRefine((task, context) => {
  if (task.dueTime !== null && task.dueDate === null) context.addIssue({ code: "custom", path: ["dueDate"], message: "A due time requires a due date." });
});

const briefingSavingsGoalSchema = z.object({
  title: z.string().trim().min(1).max(120),
  currentAmount: moneyAmountSchema,
  targetAmount: moneyAmountSchema.positive(),
  progressPercent: progressPercentSchema,
}).strict().superRefine((goal, context) => {
  const expectedPercent = Math.min((goal.currentAmount / goal.targetAmount) * 100, 100);
  if (Math.abs(goal.progressPercent - expectedPercent) > 0.11) context.addIssue({ code: "custom", path: ["progressPercent"], message: "Progress percentage does not match the supplied balances." });
});

export const dailyBriefingToolResultSchema = z.object({
  name: z.literal("generate_daily_briefing"),
  preferredName: z.string().trim().min(1).max(80),
  localDate: localDateSchema,
  timezone: timezoneSchema,
  currentCheckIn: briefingCheckinSchema.nullable(),
  today: z.object({
    events: z.array(briefingEventSchema).max(MAX_DAILY_CONTEXT_RECORDS),
    tasks: z.array(briefingTaskSchema).max(MAX_DAILY_CONTEXT_RECORDS),
    overdueTasks: z.array(briefingTaskSchema).max(MAX_DAILY_CONTEXT_RECORDS),
  }).strict(),
  week: z.object({
    eventCount: z.number().int().nonnegative().max(1_000),
    taskCount: z.number().int().nonnegative().max(1_000),
    busiestDay: weekdaySchema.nullable(),
    openDays: z.array(weekdaySchema).max(7),
  }).strict(),
  featuredSavingsGoal: briefingSavingsGoalSchema.nullable(),
  recentCheckInInsights: z.object({
    totalCheckIns: z.number().int().nonnegative().max(90),
    averageEnergy: z.number().finite().min(1).max(5).nullable(),
    averageStress: z.number().finite().min(1).max(5).nullable(),
  }).strict().nullable(),
}).strict().superRefine((result, context) => {
  const totalRecords = result.today.events.length + result.today.tasks.length + result.today.overdueTasks.length;
  if (totalRecords > MAX_DAILY_CONTEXT_RECORDS) context.addIssue({ code: "custom", path: ["today"], message: "Daily context contains too many records." });
  if (new Set(result.week.openDays).size !== result.week.openDays.length) context.addIssue({ code: "custom", path: ["week", "openDays"], message: "Open days must be unique." });
  const insights = result.recentCheckInInsights;
  if (insights?.totalCheckIns === 0 && (insights.averageEnergy !== null || insights.averageStress !== null)) context.addIssue({ code: "custom", path: ["recentCheckInInsights"], message: "Empty insights cannot contain averages." });
  if (insights && insights.totalCheckIns > 0 && (insights.averageEnergy === null || insights.averageStress === null)) context.addIssue({ code: "custom", path: ["recentCheckInInsights"], message: "Averages are required when insights contain samples." });
});

export const intelligenceToolResultSchema = z.discriminatedUnion("name", [
  savingsProgressToolResultSchema,
  checkinInsightsToolResultSchema,
  dailyBriefingToolResultSchema,
]);

export type SavingsProgressArguments = z.infer<typeof savingsProgressArgumentsSchema>;
export type CheckinInsightArguments = z.infer<typeof checkinInsightArgumentsSchema>;
export type DailyBriefingArguments = z.infer<typeof dailyBriefingArgumentsSchema>;
export type SavingsProgressToolResult = z.infer<typeof savingsProgressToolResultSchema>;
export type CheckinInsightsToolResult = z.infer<typeof checkinInsightsToolResultSchema>;
export type DailyBriefingToolResult = z.infer<typeof dailyBriefingToolResultSchema>;
export type IntelligenceToolResult = z.infer<typeof intelligenceToolResultSchema>;
