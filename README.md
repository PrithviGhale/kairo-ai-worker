# Kairo AI Worker

Cloudflare Workers AI backend for Kairo. It preserves the conversational API and adds a strictly validated calendar-extraction API that can propose—but never persist—an event.

## Routes

- `GET /health` reports service readiness.
- `POST /api/kairo` returns a conversational `{ "ok": true, "reply": "..." }` response.
- `POST /api/kairo-structured` interprets a possible calendar event and returns a `message`, `follow_up`, or `proposed_action` response.
- `POST /api/chat` powers the included streaming sample application.
- Static files under `public/` are served through the existing `ASSETS` binding.

`OPTIONS` requests are supported for Expo development.

## Structured calendar API

Example request:

```json
{
  "message": "Add to my calendar I have FIFA game Sunday at 3 PM till 4:45 PM",
  "history": [],
  "currentDate": "2026-07-17T14:00:00.000Z",
  "timezone": "America/New_York"
}
```

The endpoint uses the supplied date and IANA timezone to resolve relative dates. It repairs common time punctuation, understands time ranges and durations, cleans event titles, and asks a focused follow-up when a date, time, title, duration, or AM/PM period is genuinely unclear.

Successful structured responses are one of:

- `message` for a non-calendar response;
- `follow_up` with a locally resumable `create_event` proposal;
- `proposed_action` with `requiresConfirmation: true`.

Only `create_event` is allowed. All model output is checked against a strict JSON Schema during generation and validated again with Zod before it can be returned. The Worker does not connect to the mobile database and cannot save an event.

## Development

Requirements: Node.js 18 or newer, a Cloudflare account, and Workers AI access.

```bash
npm install
npm run dev
```

Useful commands:

```bash
npm test
npm run check
npx wrangler deploy --dry-run
```

Deploy intentionally with:

```bash
npm run deploy
```

The bindings and compatibility settings are defined in `wrangler.jsonc`:

- `AI`: Workers AI binding
- `ASSETS`: static assets in `public/`

## Safety and limits

- JSON requests only, with a 32 KiB body limit.
- Messages are capped at 2,000 characters.
- At most the latest eight valid history messages are accepted.
- Unsupported methods and malformed inputs are rejected before an AI call.
- Responses reject unknown actions, extra fields, invalid dates or times, unsafe ranges, and persistence claims.
- Logs contain error categories, not full private conversations.
- CORS is open for Expo development and responses are not cached.

The endpoint is public during development. A production deployment still needs durable authentication, platform-level rate limiting, quota monitoring, and stricter origin policy. The Worker URL is not a secret and no credentials belong in this repository or in the mobile application.
