export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Env {
  AI: {
    run: (
      model: string,
      input: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => Promise<unknown>;
  };
  ASSETS: {
    fetch: (request: Request) => Promise<Response>;
  };
}
