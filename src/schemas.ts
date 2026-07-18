import { z } from "zod";

export const MAX_MESSAGE_LENGTH = 2_000;
export const MAX_HISTORY_MESSAGES = 8;
export const MAX_HISTORY_CONTENT_LENGTH = 2_000;
export const MAX_REQUEST_BYTES = 32_768;

const isValidDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

export const localDateSchema = z.string().refine(isValidDate, "Invalid local date.");
export const localTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Invalid local time.");

export const historyMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(MAX_HISTORY_CONTENT_LENGTH),
}).strict();

const isValidTimezone = (value: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

export const structuredRequestSchema = z.object({
  message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
  history: z.array(historyMessageSchema).max(MAX_HISTORY_MESSAGES).default([]),
  currentDate: z.string().refine(
    (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value)),
    "Invalid ISO datetime.",
  ),
  timezone: z.string().trim().min(1).max(100).refine(isValidTimezone, "Invalid IANA timezone."),
}).strict();

const safeReplySchema = z.string().trim().min(1).max(800).refine(
  (reply) => !/\b(?:i|we|kairo)\s+(?:have\s+)?(?:added|saved|created)\b|\b(?:event|appointment|game|meeting)\s+(?:has|was)\s+(?:been\s+)?(?:added|saved|created)\b/i.test(reply),
  "The reply must not claim that data was saved.",
);

const confidenceSchema = z.number().min(0).max(1);
const nullableTextSchema = z.string().trim().min(1).max(500).nullable();
const missingFieldSchema = z.enum(["title", "date", "startTimeOrAllDay", "endTimeOrDuration", "timeMeridiem"]);

const collectedDataSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  date: localDateSchema.optional(),
  startTime: localTimeSchema.optional(),
  endTime: localTimeSchema.optional(),
  allDay: z.boolean().optional(),
  crossesMidnight: z.boolean().optional(),
  location: nullableTextSchema.optional(),
  reminderMinutesBefore: z.number().int().nonnegative().max(43_200).nullable().optional(),
  description: nullableTextSchema.optional(),
  durationMinutes: z.number().int().positive().max(720).optional(),
}).strict();

const eventDataSchema = z.object({
  title: z.string().trim().min(1).max(120),
  date: localDateSchema,
  startTime: localTimeSchema.nullable(),
  endTime: localTimeSchema.nullable(),
  allDay: z.boolean(),
  crossesMidnight: z.boolean().default(false),
  location: nullableTextSchema,
  reminderMinutesBefore: z.number().int().nonnegative().max(43_200).nullable(),
  description: nullableTextSchema,
}).strict().superRefine((data, context) => {
  if (data.allDay) {
    if (data.startTime !== null || data.endTime !== null || data.crossesMidnight) {
      context.addIssue({ code: "custom", message: "All-day events must not include times." });
    }
    return;
  }

  if (!data.startTime || !data.endTime) {
    context.addIssue({ code: "custom", message: "Timed events require start and end times." });
    return;
  }

  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const start = minutes(data.startTime);
  const end = minutes(data.endTime) + (data.crossesMidnight ? 1_440 : 0);
  const duration = end - start;
  if (duration <= 0 || duration > 720) {
    context.addIssue({ code: "custom", message: "The event time range is invalid or unreasonable." });
  }
  if (data.crossesMidnight && minutes(data.endTime) > start) {
    context.addIssue({ code: "custom", message: "Crossing midnight must be explicit and consistent with the times." });
  }
});

export const messageResponseSchema = z.object({
  ok: z.literal(true),
  type: z.literal("message"),
  reply: safeReplySchema,
}).strict();

export const followUpResponseSchema = z.object({
  ok: z.literal(true),
  type: z.literal("follow_up"),
  reply: safeReplySchema,
  pendingAction: z.object({
    action: z.literal("create_event"),
    originalMessage: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
    collectedData: collectedDataSchema,
    missingFields: z.array(missingFieldSchema).min(1),
    confidence: confidenceSchema,
  }).strict(),
}).strict();

export const proposedActionResponseSchema = z.object({
  ok: z.literal(true),
  type: z.literal("proposed_action"),
  reply: safeReplySchema,
  action: z.object({
    action: z.literal("create_event"),
    requiresConfirmation: z.literal(true),
    confidence: confidenceSchema,
    originalMessage: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
    data: eventDataSchema,
  }).strict(),
}).strict();

export const structuredResponseSchema = z.discriminatedUnion("type", [
  messageResponseSchema,
  followUpResponseSchema,
  proposedActionResponseSchema,
]);

export type StructuredRequest = z.infer<typeof structuredRequestSchema>;
export type StructuredResponse = z.infer<typeof structuredResponseSchema>;
export type FollowUpResponse = z.infer<typeof followUpResponseSchema>;
export type ProposedActionResponse = z.infer<typeof proposedActionResponseSchema>;

export const structuredResponseJsonSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { const: true },
        type: { const: "message" },
        reply: { type: "string", minLength: 1, maxLength: 800 },
      },
      required: ["ok", "type", "reply"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { const: true },
        type: { const: "follow_up" },
        reply: { type: "string", minLength: 1, maxLength: 800 },
        pendingAction: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { const: "create_event" },
            originalMessage: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_LENGTH },
            collectedData: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string", minLength: 1, maxLength: 120 },
                date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
                startTime: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
                endTime: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
                allDay: { type: "boolean" },
                crossesMidnight: { type: "boolean" },
                location: { type: ["string", "null"] },
                reminderMinutesBefore: { type: ["integer", "null"], minimum: 0 },
                description: { type: ["string", "null"] },
                durationMinutes: { type: "integer", minimum: 1, maximum: 720 },
              },
            },
            missingFields: {
              type: "array",
              minItems: 1,
              items: { enum: ["title", "date", "startTimeOrAllDay", "endTimeOrDuration", "timeMeridiem"] },
            },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["action", "originalMessage", "collectedData", "missingFields", "confidence"],
        },
      },
      required: ["ok", "type", "reply", "pendingAction"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { const: true },
        type: { const: "proposed_action" },
        reply: { type: "string", minLength: 1, maxLength: 800 },
        action: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { const: "create_event" },
            requiresConfirmation: { const: true },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            originalMessage: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_LENGTH },
            data: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string", minLength: 1, maxLength: 120 },
                date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
                startTime: { type: ["string", "null"], pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
                endTime: { type: ["string", "null"], pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
                allDay: { type: "boolean" },
                crossesMidnight: { type: "boolean" },
                location: { type: ["string", "null"] },
                reminderMinutesBefore: { type: ["integer", "null"], minimum: 0 },
                description: { type: ["string", "null"] },
              },
              required: ["title", "date", "startTime", "endTime", "allDay", "crossesMidnight", "location", "reminderMinutesBefore", "description"],
            },
          },
          required: ["action", "requiresConfirmation", "confidence", "originalMessage", "data"],
        },
      },
      required: ["ok", "type", "reply", "action"],
    },
  ],
} as const;
