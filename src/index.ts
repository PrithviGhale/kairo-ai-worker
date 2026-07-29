import {
  historyMessageSchema,
  MAX_HISTORY_MESSAGES,
  MAX_REQUEST_BYTES,
  structuredRequestSchema,
} from "./schemas";
import { runStructuredExtraction } from "./structured";
import type { ChatMessage, Env } from "./types";

const CONVERSATIONAL_MODEL_ID = "@cf/openai/gpt-oss-120b";
const REWRITE_MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fast";
const DEFAULT_REPLY_WORD_LIMIT = 180;
const CONCISE_REPLY_WORD_LIMIT = 100;

const SYSTEM_PROMPT = `
You are Kairo, a calm, intelligent, and helpful personal planning assistant.

Conversation style:
- Infer the user's intended meaning even when spelling, grammar, or dictation is imperfect.
- Answer the actual intent directly instead of repeating or lightly rephrasing the user's message.
- Silently correct obvious spelling and wording mistakes in names and proposed titles.
- Use natural, warm language with varied sentence structure; do not sound like a form or template.
- HARD LENGTH LIMIT: stay under 160 words unless the user explicitly asks for a detailed answer. Choose only the essential points and never begin a section that cannot be completed within this limit.
- When the user asks for a short, simple, concise, one-step, or one-suggestion answer, stay under 100 words and still provide a complete answer.
- Do not use a table unless the user asks for one.
- Acknowledge what you understood when that helps, but do not restate the entire request.
- Never ask for information the user already supplied, including an explicit start time, end time, or duration.
- When ambiguity genuinely changes the result, explain the ambiguity in one short sentence and ask one focused question.
- Answer generic requests for a plan, explanation, tip, rewrite, calculation, or advice immediately. Do not ask a follow-up merely to personalize an answer; provide a useful default first and invite refinement afterward if helpful.

Your responsibilities:
- Answer normal conversational questions naturally.
- Help users organize tasks, calendar events, goals, and schedules.
- Improve casual wording into concise, professional titles.
- Ask one focused follow-up question when important information is missing.
- For app actions, ask only when a missing field prevents a safe proposal. For ordinary conversation, ask only when the request cannot be answered responsibly without the missing detail.
- Never claim that an event, task, reminder, or goal has already been saved.
- Never assume that an unclear date means today.
- Never assume an event time when the user did not provide one.
- Before proposing an app action, clearly summarize what should be created.
- The Kairo mobile app handles confirmation and saving.
- Current app actions are limited to preparing new tasks, calendar events, savings goals, and contributions for confirmation. Do not claim support for recurring items, automatic reminders, direct editing, rescheduling, deletion, email, messaging, or external calendar access.
- If asked what you can do, mention only: planning and explanations, preparing new tasks, preparing new calendar events, preparing savings goals, and preparing contributions. State that the user confirms changes in the app. Do not expand this list.
- You do not see the user's local SQLite data in this remote endpoint. Never claim to have inspected their calendar, tasks, or goals.
- Keep responses friendly, useful, and reasonably concise.

Example:
User: Sunday is the World Cup final. Add it to my calendar.
Assistant: I can prepare the World Cup Final for Sunday. Should I make it an all-day event, or does it start at a specific time?
`.trim();

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

export function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (message.role === "user" || message.role === "assistant") && typeof message.content === "string" && message.content.trim().length > 0;
}

export const extractAssistantText = (result: unknown) => {
  if (typeof result === "string") return result.trim();
  if (!result || typeof result !== "object") return "";
  const record = result as Record<string, unknown>;
  if (typeof record.response === "string") return record.response.trim();
  if (typeof record.output_text === "string") return record.output_text.trim();

  const choices = Array.isArray(record.choices) ? record.choices : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const message = (choice as Record<string, unknown>).message;
    if (message && typeof message === "object" && typeof (message as Record<string, unknown>).content === "string") {
      const content = ((message as Record<string, unknown>).content as string).trim();
      if (content) return content;
    }
  }

  const output = Array.isArray(record.output) ? record.output : [];
  const textParts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const partRecord = part as Record<string, unknown>;
      if ((partRecord.type === "output_text" || partRecord.type === "text") && typeof partRecord.text === "string") textParts.push(partRecord.text);
    }
  }
  return textParts.join("\n").trim();
};

const countWords = (value: string) => value.trim().match(/\S+/g)?.length ?? 0;

type RequestedStructure = { count: number; label: "Day" | "Step" };

const numberWords: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
};

const parseRequestedCount = (value: string) => {
  const normalized = value.toLowerCase();
  return /^\d+$/.test(normalized) ? Number(normalized) : numberWords[normalized];
};

const requestedStructure = (message: string): RequestedStructure | null => {
  const dayMatch = message.match(/\b(one|two|three|four|five|six|seven|[1-7])[- ]day\b/i);
  if (dayMatch) return { count: parseRequestedCount(dayMatch[1]), label: "Day" };
  const stepMatch = message.match(/\b(one|two|three|four|five|six|seven|[1-7])\s+(?:practical\s+)?steps?\b/i);
  if (stepMatch) return { count: parseRequestedCount(stepMatch[1]), label: "Step" };
  return null;
};

const hasRequestedStructure = (reply: string, structure: RequestedStructure | null) => {
  if (!structure) return true;
  return Array.from({ length: structure.count }, (_, index) => index + 1).every((number) => (
    new RegExp(`\\b${structure.label}\\s*${number}\\b`, "i").test(reply)
      || (structure.label === "Step" && new RegExp(`(?:^|\\n)\\s*${number}[.)]`, "m").test(reply))
  ));
};

const requestedReplyWordLimit = (message: string, structure = requestedStructure(message)) => {
  if (structure && structure.count > 1) return 160;
  return /\b(?:short|brief|concise|simple|one[- ](?:step|sentence|suggestion|tip)|one good first step|in \d+ sentences?)\b/i.test(message)
    ? CONCISE_REPLY_WORD_LIMIT
    : DEFAULT_REPLY_WORD_LIMIT;
};

const looksIncomplete = (reply: string) => {
  const trimmed = reply.trim();
  if (!trimmed) return true;
  return !/[.!?…][\])}'\"]*$/.test(trimmed);
};

const clipAtSentenceBoundary = (reply: string, wordLimit: number) => {
  const normalized = reply.replace(/\s+/g, " ").trim();
  if (countWords(normalized) <= wordLimit && !looksIncomplete(normalized)) return normalized;

  const sentences = normalized.match(/[^.!?…]+[.!?…]+[\])}'\"]*|[^.!?…]+$/g) ?? [];
  const kept: string[] = [];
  let usedWords = 0;
  for (const sentence of sentences) {
    const cleanSentence = sentence.trim();
    const sentenceWords = countWords(cleanSentence);
    if (!cleanSentence || usedWords + sentenceWords > wordLimit) break;
    kept.push(cleanSentence);
    usedWords += sentenceWords;
  }
  if (kept.length > 0) return kept.join(" ");

  const words = normalized.split(/\s+/).slice(0, Math.max(1, wordLimit - 1));
  return `${words.join(" ").replace(/[,;:\-–—]+$/, "")}…`;
};

const compactStructuredReply = (reply: string, structure: RequestedStructure, wordLimit: number) => {
  if (!hasRequestedStructure(reply, structure)) return clipAtSentenceBoundary(reply, wordLimit);
  const sections: string[] = [];
  for (let number = 1; number <= structure.count; number += 1) {
    const label = new RegExp(`(?:^|\\n|\\s)(?:${structure.label}\\s*)?${number}[.):\\-]?\\s*`, "i");
    const currentMatch = label.exec(reply);
    if (!currentMatch) continue;
    const bodyStart = currentMatch.index + currentMatch[0].length;
    const nextLabel = number < structure.count
      ? new RegExp(`(?:^|\\n|\\s)(?:${structure.label}\\s*)?${number + 1}[.):\\-]?\\s*`, "i").exec(reply.slice(bodyStart))
      : null;
    const body = reply.slice(bodyStart, nextLabel ? bodyStart + nextLabel.index : undefined).trim();
    const firstSentence = body.match(/^[\s\S]*?[.!?…](?=\s|$)/)?.[0]?.trim() ?? body;
    if (firstSentence) sections.push(`${structure.label} ${number}: ${firstSentence}`);
  }
  const compact = sections.join("\n");
  return compact && countWords(compact) <= wordLimit ? compact : clipAtSentenceBoundary(compact || reply, wordLimit);
};

const ensureCompleteConciseReply = async (env: Env, message: string, draftReply: string) => {
  const structure = requestedStructure(message);
  const wordLimit = requestedReplyWordLimit(message, structure);
  if (countWords(draftReply) <= wordLimit && !looksIncomplete(draftReply) && hasRequestedStructure(draftReply, structure)) return draftReply;

  const structureInstruction = structure
    ? ` The user requested exactly ${structure.count} ${structure.label.toLowerCase()}s. Include every one using these labels: ${Array.from({ length: structure.count }, (_, index) => `${structure.label} ${index + 1}:`).join(", ")} Use one brief, useful sentence per label with no introduction or closing.`
    : "";

  try {
    const result = await env.AI.run(REWRITE_MODEL_ID, {
      messages: [
        {
          role: "system",
          content: `Write the final answer to the user's request in at most ${wordLimit} words. Make it complete, direct, warm, and natural. Preserve every explicitly requested part or numbered item. Correct obvious dictation errors silently. Do not mention this rewrite, do not invent app capabilities, and do not ask a follow-up when a useful default answer is possible.${structureInstruction}`,
        },
        {
          role: "user",
          content: structure
            ? `Original request:\n${message}\n\nAnswer only with the required labeled sections.`
            : `Original request:\n${message}\n\nDraft to improve:\n${draftReply}`,
        },
      ],
      max_tokens: 320,
      temperature: 0,
    });
    const rewritten = extractAssistantText(result);
    if (rewritten) {
      if (structure && hasRequestedStructure(rewritten, structure)) return compactStructuredReply(rewritten, structure, wordLimit);
      if (structure) {
        const labels = Array.from({ length: structure.count }, (_, index) => `${structure.label} ${index + 1}:`).join("\n");
        const repairResult = await env.AI.run(REWRITE_MODEL_ID, {
          messages: [
            {
              role: "system",
              content: `Answer the request in at most ${wordLimit} words. Your entire response must contain exactly these ${structure.count} labeled lines:\n${labels}\nWrite one short, useful sentence after every label. Do not add an introduction, closing, or question.`,
            },
            { role: "user", content: message },
          ],
          max_tokens: 260,
          temperature: 0,
        });
        const repaired = extractAssistantText(repairResult);
        if (repaired && hasRequestedStructure(repaired, structure)) return compactStructuredReply(repaired, structure, wordLimit);
      }
      return clipAtSentenceBoundary(rewritten, wordLimit);
    }
  } catch (error) {
    console.error("Kairo reply rewrite failed:", error instanceof Error ? error.name : "UnknownError");
  }

  return clipAtSentenceBoundary(draftReply, wordLimit);
};

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "RequestError";
  }
}

export async function readLimitedJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new RequestError(415, "Content-Type must be application/json.");
  const declaredLength = Number(request.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) throw new RequestError(413, "The request is too large.");
  if (!request.body) throw new RequestError(400, "Please provide a JSON request body.");

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new RequestError(413, "The request is too large.");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();

  try {
    return JSON.parse(text);
  } catch {
    throw new RequestError(400, "The request body must contain valid JSON.");
  }
}

const sanitizeStructuredBody = (body: unknown) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  if (record.history !== undefined && !Array.isArray(record.history)) return record;
  const history = Array.isArray(record.history)
    ? record.history.flatMap((item) => {
      const parsed = historyMessageSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }).slice(-MAX_HISTORY_MESSAGES)
    : [];
  return { ...record, history };
};

export async function handleStructuredRequest(request: Request, env: Env): Promise<Response> {
  try {
    const rawBody = await readLimitedJson(request);
    const parsed = structuredRequestSchema.safeParse(sanitizeStructuredBody(rawBody));
    if (!parsed.success) return jsonResponse({ ok: false, error: "Please provide a valid calendar request." }, 400);
    const result = await runStructuredExtraction(env, parsed.data);
    return jsonResponse(result);
  } catch (error) {
    if (error instanceof RequestError) return jsonResponse({ ok: false, error: error.message }, error.status);
    const category = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    console.error("Kairo structured request failed:", category);
    if (category === "MODEL_RUN_FAILED") {
      return jsonResponse({ ok: false, error: "The structured AI service is temporarily unavailable." }, 502);
    }
    if (category === "MODEL_JSON_INVALID" || category === "MODEL_RESPONSE_INVALID") {
      return jsonResponse({ ok: false, error: "Kairo received an invalid structured response." }, 502);
    }
    return jsonResponse({ ok: false, error: "Kairo could not safely interpret that calendar request." }, 502);
  }
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    if (url.pathname === "/health" && request.method === "GET") return jsonResponse({ ok: true, service: "Kairo AI", status: "ready" });

    if (url.pathname === "/api/kairo-structured") {
      if (request.method !== "POST") return jsonResponse({ ok: false, error: "Method not allowed." }, 405, { Allow: "POST, OPTIONS" });
      return handleStructuredRequest(request, env);
    }

    if (url.pathname === "/api/kairo" && request.method === "POST") return handleKairoRequest(request, env);

    if (url.pathname === "/api/chat") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return handleTemplateChatRequest(request, env);
    }

    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    return jsonResponse({
      ok: false,
      error: "Route not found.",
      availableRoutes: ["GET /health", "POST /api/kairo", "POST /api/kairo-structured", "POST /api/chat"],
    }, 404);
  },
};

export default worker;

async function handleKairoRequest(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    if (!message) return jsonResponse({ ok: false, error: "Please provide a message." }, 400);
    if (/\b(?:what can you do|what can you help(?: me)? with|how can you help(?: me)?)\b/i.test(message)) {
      return jsonResponse({
        ok: true,
        reply: "I can help you plan, explain ideas, and prepare new tasks, calendar events, savings goals, and goal contributions. Kairo shows every proposed change for your confirmation before saving it.",
      });
    }

    const history = Array.isArray(body?.history) ? body.history.filter(isChatMessage).slice(-8) : [];
    const currentDate = typeof body?.currentDate === "string" ? body.currentDate : new Date().toISOString();
    const timezone = typeof body?.timezone === "string" ? body.timezone : "Unknown";
    const result = await env.AI.run(CONVERSATIONAL_MODEL_ID, {
      messages: [
        { role: "system", content: `${SYSTEM_PROMPT}\n\nCurrent date and time: ${currentDate}\nUser timezone: ${timezone}` },
        ...history,
        { role: "user", content: message },
      ],
      max_tokens: 500,
      temperature: 0.2,
    });
    const draftReply = extractAssistantText(result);
    if (!draftReply) return jsonResponse({ ok: false, error: "The AI returned an empty response." }, 502);
    const reply = await ensureCompleteConciseReply(env, message, draftReply);
    return jsonResponse({ ok: true, reply });
  } catch (error) {
    console.error("Kairo AI request failed:", error instanceof Error ? error.name : "UnknownError");
    return jsonResponse({ ok: false, error: "Kairo could not process that request." }, 500);
  }
}

async function handleTemplateChatRequest(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as { messages?: ChatMessage[] };
    const messages = Array.isArray(body.messages) ? [...body.messages] : [];
    if (!messages.some((message) => message.role === "system")) messages.unshift({ role: "system", content: SYSTEM_PROMPT });
    const stream = await env.AI.run(CONVERSATIONAL_MODEL_ID, { messages, max_tokens: 1024, stream: true });
    return new Response(stream as BodyInit, {
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  } catch (error) {
    console.error("Template chat request failed:", error instanceof Error ? error.name : "UnknownError");
    return jsonResponse({ error: "Failed to process the chat request." }, 500);
  }
}
