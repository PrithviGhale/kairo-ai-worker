import { z } from "zod";

import {
  historyMessageSchema,
  localDateSchema,
  localTimeSchema,
  MAX_HISTORY_MESSAGES,
  MAX_MESSAGE_LENGTH,
} from "./schemas";

export const ASSISTANT_V2_MODEL_ID = "@cf/openai/gpt-oss-120b";
export const MAX_ASSISTANT_REPLY_LENGTH = 1_200;

export const assistantActionSchema = z.enum([
  "create_calendar_event",
  "create_task",
  "create_savings_goal",
  "add_goal_contribution",
  "answer_schedule_question",
]);

const nullableShortText = z.string().trim().min(1).max(500).nullable();
const nullableDate = localDateSchema.nullable();
const nullableTime = localTimeSchema.nullable();
const amountSchema = z.number().finite().nonnegative().max(1_000_000_000);

const contextItemSchema = z.record(z.string().max(100), z.unknown());
const appContextSchema = z.object({
  relevantTasks: z.array(contextItemSchema).max(20).default([]),
  relevantEvents: z.array(contextItemSchema).max(20).default([]),
  relevantGoals: z.array(contextItemSchema).max(20).default([]),
}).strict();

export const pendingActionRequestSchema = z.object({
  action: assistantActionSchema,
  collectedData: z.record(z.string().max(100), z.unknown()),
  missingFields: z.array(z.string().trim().min(1).max(100)).max(20),
}).strict();

export const assistantV2RequestSchema = z.object({
  message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
  history: z.array(historyMessageSchema).max(MAX_HISTORY_MESSAGES).default([]),
  currentDate: z.string().refine(
    (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value)),
    "Invalid ISO datetime.",
  ),
  timezone: z.string().trim().min(1).max(100).refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
      return true;
    } catch {
      return false;
    }
  }, "Invalid IANA timezone."),
  pendingAction: pendingActionRequestSchema.nullable().default(null),
  appContext: appContextSchema.default({ relevantTasks: [], relevantEvents: [], relevantGoals: [] }),
}).strict();

const safeReplySchema = z.string().trim().min(1).max(MAX_ASSISTANT_REPLY_LENGTH).refine(
  (reply) => !/(?:\b(?:i|we|kairo)\s+(?:have\s+)?(?:added|saved|created|updated|scheduled|completed|put|placed)\b|\b(?:event|task|goal|contribution|appointment|meeting)\s+(?:has|was|is)\s+(?:been\s+)?(?:added|saved|created|updated|scheduled|completed)\b|\b(?:done|all set)\b|\b(?:it|that)\s+is\s+now\s+(?:on|in)\s+your\b)/i.test(reply),
  "The reply must not claim an action was completed.",
);

const calendarEventArgumentsSchema = z.object({
  title: z.string().trim().min(1).max(120),
  date: localDateSchema,
  startTime: nullableTime,
  endTime: nullableTime,
  allDay: z.boolean(),
  location: nullableShortText,
  notes: nullableShortText,
  reminderMinutesBefore: z.number().int().nonnegative().max(43_200).nullable(),
  crossesMidnight: z.boolean().default(false),
}).strict().superRefine((data, context) => {
  if (data.allDay) {
    if (data.startTime !== null || data.endTime !== null || data.crossesMidnight) {
      context.addIssue({ code: "custom", message: "All-day events cannot contain times." });
    }
    return;
  }
  if (!data.startTime) context.addIssue({ code: "custom", path: ["startTime"], message: "Timed events require a start time." });
  if (data.endTime && data.startTime) {
    const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
    const start = minutes(data.startTime);
    const end = minutes(data.endTime) + (data.crossesMidnight ? 1_440 : 0);
    if (end <= start || end - start > 1_440) context.addIssue({ code: "custom", path: ["endTime"], message: "Invalid event range." });
    if (data.crossesMidnight && minutes(data.endTime) >= start) context.addIssue({ code: "custom", path: ["crossesMidnight"], message: "Invalid overnight range." });
  }
});

const taskArgumentsSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: nullableShortText,
  dueDate: nullableDate,
  dueTime: nullableTime,
  priority: z.enum(["low", "medium", "high"]).nullable(),
  estimatedMinutes: z.number().int().positive().max(10_080).nullable(),
  notes: nullableShortText,
}).strict().superRefine((data, context) => {
  if (data.dueTime !== null && data.dueDate === null) context.addIssue({ code: "custom", path: ["dueDate"], message: "A due time requires a due date." });
});

const savingsGoalArgumentsSchema = z.object({
  title: z.string().trim().min(1).max(120),
  targetAmount: amountSchema.positive(),
  startingAmount: amountSchema,
  targetDate: nullableDate,
  description: nullableShortText,
}).strict().refine((data) => data.startingAmount <= data.targetAmount, { path: ["startingAmount"], message: "Starting amount cannot exceed target amount." });

const contributionArgumentsSchema = z.object({
  goalName: z.string().trim().min(1).max(120),
  amount: amountSchema.positive(),
  date: localDateSchema,
  note: nullableShortText,
}).strict();

const scheduleRangeSchema = z.object({ startDate: localDateSchema, endDate: localDateSchema }).strict().refine(
  (range) => range.startDate <= range.endDate,
  { path: ["endDate"], message: "The requested range is invalid." },
);

const scheduleQuestionArgumentsSchema = z.object({
  questionType: z.enum(["day", "range", "availability", "conflicts", "upcoming"]),
  requestedDate: nullableDate,
  requestedRange: scheduleRangeSchema.nullable(),
}).strict().superRefine((data, context) => {
  if (data.questionType === "range" && data.requestedRange === null) context.addIssue({ code: "custom", path: ["requestedRange"], message: "Range questions require a range." });
  if (data.requestedDate !== null && data.requestedRange !== null) context.addIssue({ code: "custom", message: "Use a date or a range, not both." });
});

export const toolArgumentSchemas = {
  create_calendar_event: calendarEventArgumentsSchema,
  create_task: taskArgumentsSchema,
  create_savings_goal: savingsGoalArgumentsSchema,
  add_goal_contribution: contributionArgumentsSchema,
  answer_schedule_question: scheduleQuestionArgumentsSchema,
} as const;

const calendarEventDraftSchema = z.object({
  title: z.string().trim().min(1).max(120).nullable().optional(), date: nullableDate.optional(), startTime: nullableTime.optional(), endTime: nullableTime.optional(),
  allDay: z.boolean().nullable().optional(), location: nullableShortText.optional(), notes: nullableShortText.optional(),
  reminderMinutesBefore: z.number().int().nonnegative().max(43_200).nullable().optional(), crossesMidnight: z.boolean().optional(),
}).strict().superRefine((data, context) => {
  if (data.startTime && data.endTime) {
    const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
    const start = minutes(data.startTime);
    const end = minutes(data.endTime) + (data.crossesMidnight ? 1_440 : 0);
    if (end <= start || end - start > 1_440) context.addIssue({ code: "custom", path: ["endTime"], message: "Invalid event range." });
    if (data.crossesMidnight && minutes(data.endTime) >= start) context.addIssue({ code: "custom", path: ["crossesMidnight"], message: "Invalid overnight range." });
  }
});

const taskDraftSchema = z.object({
  title: z.string().trim().min(1).max(120).nullable().optional(), description: nullableShortText.optional(), dueDate: nullableDate.optional(), dueTime: nullableTime.optional(),
  priority: z.enum(["low", "medium", "high"]).nullable().optional(), estimatedMinutes: z.number().int().positive().max(10_080).nullable().optional(), notes: nullableShortText.optional(),
}).strict();

const savingsGoalDraftSchema = z.object({
  title: z.string().trim().min(1).max(120).nullable().optional(), targetAmount: amountSchema.positive().nullable().optional(),
  startingAmount: amountSchema.nullable().optional(), targetDate: nullableDate.optional(), description: nullableShortText.optional(),
}).strict().superRefine((data, context) => {
  if (data.targetAmount != null && data.startingAmount != null && data.startingAmount > data.targetAmount) context.addIssue({ code: "custom", path: ["startingAmount"], message: "Starting amount cannot exceed target amount." });
});

const contributionDraftSchema = z.object({
  goalName: z.string().trim().min(1).max(120).nullable().optional(), amount: amountSchema.positive().nullable().optional(), date: nullableDate.optional(), note: nullableShortText.optional(),
}).strict();

const scheduleQuestionDraftSchema = z.object({
  questionType: z.enum(["day", "range", "availability", "conflicts", "upcoming"]).nullable().optional(), requestedDate: nullableDate.optional(), requestedRange: scheduleRangeSchema.nullable().optional(),
}).strict();

export const toolDraftArgumentSchemas = {
  create_calendar_event: calendarEventDraftSchema,
  create_task: taskDraftSchema,
  create_savings_goal: savingsGoalDraftSchema,
  add_goal_contribution: contributionDraftSchema,
  answer_schedule_question: scheduleQuestionDraftSchema,
} as const;

const toolCallSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("create_calendar_event"), requiresConfirmation: z.literal(true), arguments: calendarEventArgumentsSchema }).strict(),
  z.object({ name: z.literal("create_task"), requiresConfirmation: z.literal(true), arguments: taskArgumentsSchema }).strict(),
  z.object({ name: z.literal("create_savings_goal"), requiresConfirmation: z.literal(true), arguments: savingsGoalArgumentsSchema }).strict(),
  z.object({ name: z.literal("add_goal_contribution"), requiresConfirmation: z.literal(true), arguments: contributionArgumentsSchema }).strict(),
  z.object({ name: z.literal("answer_schedule_question"), requiresConfirmation: z.literal(true), arguments: scheduleQuestionArgumentsSchema }).strict(),
]);

export const assistantV2ResponseSchema = z.discriminatedUnion("type", [
  z.object({ ok: z.literal(true), type: z.literal("message"), reply: safeReplySchema }).strict(),
  z.object({
    ok: z.literal(true),
    type: z.literal("follow_up"),
    reply: safeReplySchema,
    pendingAction: z.object({
      action: assistantActionSchema,
      originalMessage: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
      collectedData: z.record(z.string(), z.unknown()),
      missingFields: z.array(z.string().trim().min(1)).min(1),
      confidence: z.number().min(0).max(1),
    }).strict(),
  }).strict(),
  z.object({ ok: z.literal(true), type: z.literal("tool_call"), reply: safeReplySchema, toolCall: toolCallSchema }).strict(),
]);

export type AssistantV2Request = z.infer<typeof assistantV2RequestSchema>;
export type AssistantAction = z.infer<typeof assistantActionSchema>;
export type AssistantV2Response = z.infer<typeof assistantV2ResponseSchema>;
