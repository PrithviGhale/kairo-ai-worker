import { extractEventHints } from "./calendar";
import {
  modelExtractionJsonSchema,
  modelExtractionSchema,
  structuredResponseSchema,
  type FollowUpResponse,
  type ProposedActionResponse,
  type StructuredRequest,
  type StructuredResponse,
  type ModelExtraction,
} from "./schemas";
import type { Env } from "./types";

export const STRUCTURED_MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fast";

const STRUCTURED_SYSTEM_PROMPT = `
You are Kairo's calendar-event interpretation service. This endpoint only interprets proposed create_event actions; it never saves data.

Rules:
- Extract every event detail the user already supplied.
- Ask one focused follow-up only for information that is genuinely missing.
- Never default a missing or unclear date to today.
- Never default a missing time to the current time.
- Never ask for duration when startTime and endTime are already known.
- When both times are known, preserve them and calculate duration internally.
- When neither time has AM or PM, ask whether the range is AM or PM.
- When only the second time has AM or PM, infer the same period for both when the resulting range is valid.
- Normalize semicolon minutes such as 4;45 PM to 4:45 PM and treat Unicode dashes as range separators.
- Resolve relative dates using the supplied current date and IANA timezone.
- Clean command wording, dates, and times out of titles.
- Preserve acronyms such as FIFA, NBA, NFL, UFC, and F1.
- Do not invent locations, people, reminders, descriptions, or details.
- Never say an event was added, created, or saved.
- Every proposed action must set requiresConfirmation to true.
- Return a small extraction draft matching the provided JSON Schema. The Worker will build and validate the final action locally.
- The draft must always include kind, reply, confidence, title, and location. Use an empty string when title or location is unknown.

Examples:
- "Add to my calendar I have FIFA game Sunday at 3 PM till 4:45 PM" becomes FIFA Game with the upcoming Sunday, 15:00 to 16:45. Do not ask for duration.
- "3 to 4:45" requires an AM-or-PM follow-up.
`.trim();

const parseModelResponse = (result: unknown): ModelExtraction => {
  const response = result && typeof result === "object" ? (result as { response?: unknown }).response : undefined;
  let candidate = response;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      throw new Error("MODEL_JSON_INVALID");
    }
  }
  const parsed = modelExtractionSchema.safeParse(candidate);
  if (!parsed.success) throw new Error("MODEL_RESPONSE_INVALID");
  return parsed.data;
};

const mentionedNullableValue = (message: string, value: string | null | undefined) => value && message.toLowerCase().includes(value.toLowerCase()) ? value : null;

const modelTitleIsGrounded = (message: string, title: unknown): title is string => {
  if (typeof title !== "string" || !title.trim()) return false;
  const sourceWords = new Set(message.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const meaningfulTitleWords = (title.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => !["a", "an", "the", "with", "and"].includes(word));
  return meaningfulTitleWords.length > 0 && meaningfulTitleWords.every((word) => sourceWords.has(word));
};

const followUp = (
  request: StructuredRequest,
  confidence: number,
  reply: string,
  missingFields: FollowUpResponse["pendingAction"]["missingFields"],
  collectedData: FollowUpResponse["pendingAction"]["collectedData"],
): FollowUpResponse => followUpResponse({
  ok: true,
  type: "follow_up",
  reply,
  pendingAction: {
    action: "create_event",
    originalMessage: request.message,
    collectedData,
    missingFields,
    confidence,
  },
});

const followUpResponse = (response: FollowUpResponse) => {
  const parsed = structuredResponseSchema.safeParse(response);
  if (!parsed.success || parsed.data.type !== "follow_up") throw new Error("SAFE_RESPONSE_INVALID");
  return parsed.data;
};

const proposedActionResponse = (response: ProposedActionResponse) => {
  const parsed = structuredResponseSchema.safeParse(response);
  if (!parsed.success || parsed.data.type !== "proposed_action") throw new Error("SAFE_RESPONSE_INVALID");
  return parsed.data;
};

export const reconcileStructuredResponse = (request: StructuredRequest, modelResponse: ModelExtraction): StructuredResponse => {
  const hints = extractEventHints(request.message, request.currentDate, request.timezone);
  if (!hints.looksLikeEvent && modelResponse.kind === "message") {
    const parsedMessage = structuredResponseSchema.safeParse({ ok: true, type: "message", reply: modelResponse.reply });
    if (!parsedMessage.success) throw new Error("SAFE_RESPONSE_INVALID");
    return parsedMessage.data;
  }

  const confidence = Math.min(modelResponse.confidence, hints.invalid ? 0.4 : 0.98);
  const title = hints.title ?? (modelTitleIsGrounded(request.message, modelResponse.title) ? modelResponse.title : undefined);
  const date = hints.hasDateExpression ? hints.date : undefined;
  const location = mentionedNullableValue(request.message, modelResponse.location);
  const baseCollected = {
    ...(title ? { title } : {}),
    ...(date ? { date } : {}),
    ...(location ? { location } : {}),
    ...(hints.durationMinutes ? { durationMinutes: hints.durationMinutes } : {}),
  };

  if (!title) return followUp(request, confidence, "What should I call this event?", ["title"], baseCollected);
  if (!date) return followUp(request, confidence, `What date is the ${title}?`, ["date"], {
    ...baseCollected,
    ...(hints.startTime ? { startTime: hints.startTime } : {}),
    ...(hints.endTime ? { endTime: hints.endTime } : {}),
    ...(hints.allDay ? { allDay: true } : {}),
  });

  if (hints.ambiguousRange) {
    const display = (time: string) => `${Number(time.slice(0, 2)) || 12}:${time.slice(3, 5)}`;
    return followUp(request, confidence, `Is that ${display(hints.ambiguousRange.startTime)}–${display(hints.ambiguousRange.endTime)} AM or PM?`, ["timeMeridiem"], baseCollected);
  }
  if (hints.ambiguousStartTime) {
    const display = `${Number(hints.ambiguousStartTime.slice(0, 2)) || 12}:${hints.ambiguousStartTime.slice(3, 5)}`;
    return followUp(request, confidence, `Is ${display} AM or PM?`, ["timeMeridiem"], baseCollected);
  }
  if (hints.ambiguousTimePeriod) return followUp(request, confidence, `What specific time in the ${hints.ambiguousTimePeriod} should I use?`, ["startTimeOrAllDay"], baseCollected);

  if (hints.allDay) return proposedActionResponse({
    ok: true,
    type: "proposed_action",
    reply: "Here is the event I prepared for your confirmation.",
    action: {
      action: "create_event",
      requiresConfirmation: true,
      confidence,
      originalMessage: request.message,
      data: { title, date, startTime: null, endTime: null, allDay: true, crossesMidnight: false, location, reminderMinutesBefore: null, description: null },
    },
  });

  if (!hints.startTime) return followUp(request, confidence, `What time does the ${title} begin, or is it all day?`, ["startTimeOrAllDay"], baseCollected);
  if (!hints.endTime) return followUp(request, confidence, `What time does the ${title} end, or how long should I block?`, ["endTimeOrDuration"], { ...baseCollected, startTime: hints.startTime, allDay: false });

  return proposedActionResponse({
    ok: true,
    type: "proposed_action",
    reply: "Here is the event I prepared for your confirmation.",
    action: {
      action: "create_event",
      requiresConfirmation: true,
      confidence,
      originalMessage: request.message,
      data: {
        title,
        date,
        startTime: hints.startTime,
        endTime: hints.endTime,
        allDay: false,
        crossesMidnight: Boolean(hints.crossesMidnight),
        location,
        reminderMinutesBefore: null,
        description: null,
      },
    },
  });
};

export const runStructuredExtraction = async (env: Env, request: StructuredRequest): Promise<StructuredResponse> => {
  // Supported calendar language takes a deterministic path so common requests
  // remain reliable even when JSON Mode is temporarily unavailable. No model
  // output is trusted or required for this high-confidence local extraction.
  if (extractEventHints(request.message, request.currentDate, request.timezone).looksLikeEvent) {
    return reconcileStructuredResponse(request, {
      kind: "create_event",
      reply: "Here is the event I prepared.",
      confidence: 0.98,
      title: "",
      location: "",
    });
  }

  let result: unknown;
  try {
    result = await env.AI.run(STRUCTURED_MODEL_ID, {
      messages: [
        {
          role: "system",
          content: `${STRUCTURED_SYSTEM_PROMPT}\n\nCurrent date and time: ${request.currentDate}\nUser timezone: ${request.timezone}`,
        },
        ...request.history,
        { role: "user", content: request.message },
      ],
      response_format: {
        type: "json_schema",
        json_schema: modelExtractionJsonSchema,
      },
      max_tokens: 700,
      temperature: 0,
    });
  } catch {
    throw new Error("MODEL_RUN_FAILED");
  }
  return reconcileStructuredResponse(request, parseModelResponse(result));
};
