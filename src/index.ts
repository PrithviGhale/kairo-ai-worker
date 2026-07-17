type ChatRole = "system" | "user" | "assistant";

type ChatMessage = {
  role: ChatRole;
  content: string;
};

type WorkerEnv = {
  AI: {
    run: (
      model: string,
      input: Record<string, unknown>,
      options?: Record<string, unknown>
    ) => Promise<unknown>;
  };
  ASSETS: {
    fetch: (request: Request) => Promise<Response>;
  };
};

const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";

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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const message = value as Record<string, unknown>;

  return (
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string" &&
    message.content.trim().length > 0
  );
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    // Test route for checking whether the Worker is online.
    if (url.pathname === "/health" && request.method === "GET") {
      return jsonResponse({
        ok: true,
        service: "Kairo AI",
        status: "ready",
      });
    }

    // Endpoint that the Kairo mobile application will use.
    if (url.pathname === "/api/kairo" && request.method === "POST") {
      return handleKairoRequest(request, env);
    }

    // Keep the original template chat page working.
    if (url.pathname === "/api/chat") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", {
          status: 405,
        });
      }

      return handleTemplateChatRequest(request, env);
    }

    // Serve the original template website.
    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    return jsonResponse(
      {
        ok: false,
        error: "Route not found.",
        availableRoutes: [
          "GET /health",
          "POST /api/kairo",
          "POST /api/chat",
        ],
      },
      404
    );
  },
};

async function handleKairoRequest(
  request: Request,
  env: WorkerEnv
): Promise<Response> {
  try {
    const body = (await request.json().catch(() => null)) as
      | Record<string, unknown>
      | null;

    const message =
      typeof body?.message === "string" ? body.message.trim() : "";

    if (!message) {
      return jsonResponse(
        {
          ok: false,
          error: "Please provide a message.",
        },
        400
      );
    }

    const history = Array.isArray(body?.history)
      ? body.history.filter(isChatMessage).slice(-8)
      : [];

    const currentDate =
      typeof body?.currentDate === "string"
        ? body.currentDate
        : new Date().toISOString();

    const timezone =
      typeof body?.timezone === "string" ? body.timezone : "Unknown";

    const result = (await env.AI.run(MODEL_ID, {
      messages: [
        {
          role: "system",
          content: `${SYSTEM_PROMPT}

Current date and time: ${currentDate}
User timezone: ${timezone}`,
        },
        ...history,
        {
          role: "user",
          content: message,
        },
      ],
      max_tokens: 500,
      temperature: 0.3,
    })) as {
      response?: unknown;
    };

    const reply =
      typeof result?.response === "string"
        ? result.response.trim()
        : "";

    if (!reply) {
      return jsonResponse(
        {
          ok: false,
          error: "The AI returned an empty response.",
        },
        502
      );
    }

    return jsonResponse({
      ok: true,
      reply,
    });
  } catch (error) {
    console.error("Kairo AI request failed:", error);

    return jsonResponse(
      {
        ok: false,
        error: "Kairo could not process that request.",
      },
      500
    );
  }
}

async function handleTemplateChatRequest(
  request: Request,
  env: WorkerEnv
): Promise<Response> {
  try {
    const body = (await request.json()) as {
      messages?: ChatMessage[];
    };

    const messages = Array.isArray(body.messages)
      ? [...body.messages]
      : [];

    if (!messages.some((message) => message.role === "system")) {
      messages.unshift({
        role: "system",
        content: SYSTEM_PROMPT,
      });
    }

    const stream = await env.AI.run(MODEL_ID, {
      messages,
      max_tokens: 1024,
      stream: true,
    });

    return new Response(stream as BodyInit, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("Template chat request failed:", error);

    return jsonResponse(
      {
        error: "Failed to process the chat request.",
      },
      500
    );
  }
}
