# Kairo AI Worker

Cloudflare Workers AI backend for Kairo. It preserves the legacy APIs and adds a remote-first assistant that can propose—but never execute or persist—app actions.

## Routes

- `GET /health` reports service readiness.
- `POST /api/assistant-v2` uses function calling for conversational replies, focused follow-ups, and confirmation-required app action proposals.
- `POST /api/kairo` returns a conversational `{ "ok": true, "reply": "..." }` response.
- `POST /api/kairo-structured` interprets a possible calendar event and returns a `message`, `follow_up`, or `proposed_action` response.
- `POST /api/chat` powers the included streaming sample application.
- Static files under `public/` are served through the existing `ASSETS` binding.

`OPTIONS` requests are supported for Expo development.

## Assistant v2 API

`POST /api/assistant-v2` uses `@cf/openai/gpt-oss-120b` and Cloudflare Workers AI traditional function calling. Its capability registry currently exposes nine validated tools:

- `create_calendar_event`
- `create_task`
- `create_savings_goal`
- `add_goal_contribution`
- `answer_schedule_question`
- `read_savings_progress`
- `read_checkin_insights`
- `generate_daily_briefing`
- `delete_calendar_event`

The endpoint accepts the newest message, up to eight history messages, the current ISO date/time and IANA timezone, an optional pending action, and only the app context explicitly included by the client. It returns `message`, `follow_up`, `tool_call`, or an ordered multi-operation `plan`. Every operation is checked against the capability registry. Writes and destructive operations require confirmation; read operations do not. The Worker validates every result at runtime, performs at most one constrained repair attempt for invalid model output, and never executes a tool or claims that app data was saved.

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

## Reliability lab

The checked-in reliability lab contains exactly 400 curated contract cases covering general conversation, calendar creation/update/deletion, schedule reads, multi-intent requests, contextual follow-ups, tasks, goals, check-ins, and ambiguity. Contract mode validates the complete dataset deterministically. Live modes call an Assistant v2 endpoint and score response type, ordered tools, operation count, important arguments, clarification fields, confirmation policy, execution mode, and forbidden claims.

```bash
npm run eval:contract
npm run eval:live:sample
npm run eval:failed
npm run eval:report
```

Set `KAIRO_ASSISTANT_V2_URL` only in the shell running a live evaluation. For example in PowerShell:

```powershell
$env:KAIRO_ASSISTANT_V2_URL='http://127.0.0.1:8787/api/assistant-v2'
npm run eval:live:sample
```

`eval:live:sample` selects 40 cases across every category, uses concurrency two, saves resumable progress, and verifies a failed case once more to distinguish stable failures from model variance. `eval:live` is available for an intentional full 400-case live run. Generated JSON and Markdown results are stored under `eval-results/`; local progress and Worker logs are ignored.

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
