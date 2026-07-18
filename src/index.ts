import {
  historyMessageSchema,
  MAX_HISTORY_MESSAGES,
  MAX_REQUEST_BYTES,
  structuredRequestSchema,
} from "./schemas";
import { runStructuredExtraction } from "./structured";
import type { ChatMessage, Env } from "./types";

const CONVERSATIONAL_MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";

const SYSTEM_PROMPT = `
You are Kairo, a calm, intelligent, and helpful personal planning assistant.

Your responsibilities:
- Answer normal conversational questions naturally.
- Help users organize tasks, calendar events, goals, and schedules.
- Improve casual wording into concise, professional titles.
- Ask one focused follow-up question when important information is missing.
- Never claim that an event, task, reminder, or goal has already been saved.
- Never assume that an unclear date means today.
- Never assume an event time when the user did not provide one.
- Before proposing an app action, clearly summarize what should be created.
- The Kairo mobile app handles confirmation and saving.
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
    console.error("Kairo structured request failed:", error instanceof Error ? error.name : "UnknownError");
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

    const history = Array.isArray(body?.history) ? body.history.filter(isChatMessage).slice(-8) : [];
    const currentDate = typeof body?.currentDate === "string" ? body.currentDate : new Date().toISOString();
    const timezone = typeof body?.timezone === "string" ? body.timezone : "Unknown";
    const result = (await env.AI.run(CONVERSATIONAL_MODEL_ID, {
      messages: [
        { role: "system", content: `${SYSTEM_PROMPT}\n\nCurrent date and time: ${currentDate}\nUser timezone: ${timezone}` },
        ...history,
        { role: "user", content: message },
      ],
      max_tokens: 500,
      temperature: 0.3,
    })) as { response?: unknown };
    const reply = typeof result?.response === "string" ? result.response.trim() : "";
    if (!reply) return jsonResponse({ ok: false, error: "The AI returned an empty response." }, 502);
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
