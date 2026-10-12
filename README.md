# background-job

An Express API with Supabase login and one protected endpoint, `POST /triage`, that reads a support message and says which team it belongs to and how urgent it is.

> Work in progress for FlyRank Week 7 (A17, "Put an LLM behind your API"). This README is completed in Stage 5.

## Setup

1. Install packages: `npm install`
2. Copy `.env.example` to `.env` and fill in your own values (never commit `.env`).
3. Start the server: `node server.js`

## Provider settings

Three environment variables are the only difference between a model running on your laptop and one running in a datacentre, so no provider is ever hard-coded: `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL`. This project currently uses Gemini through its OpenAI-compatible endpoint.

## Prompt

The prompt lives in a file, not in the route: [prompts/triage-v1.md](prompts/triage-v1.md). The version is part of the file name, so a change means a new file (`triage-v2.md`) and the two can be compared with `git diff`. It has five parts in order: role, output shape, rules, what to do when unsure, and three examples (typical, ambiguous, hostile).

The customer's message is never put in the system prompt. It is sent as a separate user message, JSON-encoded (`{"text": "..."}`), so quotes inside it cannot break out of their string. Temperature is low (0.2 by default, change it with `LLM_TEMPERATURE`) so the same input gives the same answer.

To try the real model, remove `LLM_STUB` from `.env` (or set it to `0`) and restart the server.

## Stage 2 notes: what I saw

I ran three made-up messages through the live model with prompt `triage-v1` (temperature 0.2):

| Message | Category | Urgency | Confidence |
|---|---|---|---|
| "I was charged twice for my subscription this month." | billing | high | 1.0 |
| "The export button crashes the app every time I click it, so I cannot finish my report." | bug | high | 1.0 |
| "It would be great if the dashboard had a dark mode." | feature | low | 1.0 |

All three were correct, and all three had the same shape: four fields, values from the closed lists, and no code fences or extra text.

What surprised me:

- **Confidence was 1.0 every time**, even though my own example used 0.95. The model is not calibrated, so confidence should not be trusted yet; the Stage 5 eval will show whether it matters.
- **The JSON came back clean without being forced.** The prompt only asks for it. Stage 3 still strips code fences and validates, because three clean answers prove little.
- **A low temperature worked.** Google recommends leaving Gemini 3 models at 1.0, but 0.2 gave no looping or odd output on these three inputs.

## Output handling (Stage 3)

A model's answer is treated like any other input from outside the system. Every live call goes through four steps:

1. **Parse.** Strip a markdown code fence or chatty text around the reply and find the JSON object. Bad syntax is a failure, not a crash.
2. **Validate.** Check it against the Zod schema in `src/llm/schema.js`: exactly four fields, `category` and `urgency` from the closed lists, `confidence` between 0 and 1. Extra fields are rejected.
3. **Repair once.** If parsing or validation fails, make one more call with the same prompt, the model's rejected answer, and the exact error ("Your previous answer was rejected for this reason ... Return only corrected JSON matching the schema.").
4. **Give up cleanly.** If the second answer also fails, the endpoint returns **422** and writes the input, both raw outputs, the errors and the prompt version to `logs/quarantine.jsonl` (git-ignored, because it holds user input). It never crashes and never guesses a default.

Callers only ever receive the validated JSON from the job card, or an error. Raw model text is never returned, on success or on failure.

To check this logic without calling the model or using any quota, run `node scripts/check-stage3.js`.

## Reliability (Stage 4)

- **Timeout.** The model client has a 30-second timeout (`LLM_TIMEOUT_MS`, capped at 60 seconds) instead of the SDK's ten-minute default. When it fires, the endpoint answers **504** with a clear message.
- **Retries.** I chose my own retry logic over the SDK's: the SDK's silent retries are switched off (`maxRetries: 0`), so one request is exactly one call, and `src/llm/retry.js` is the only place retries happen. It retries timeouts, **429** and **5xx** only, up to 3 times (`LLM_MAX_RETRIES`), waiting about 1s, 2s and 4s plus up to 250 ms of random jitter. If the server sends a `Retry-After` header, that wait is used instead of a guess, and a wait longer than 10 seconds is not worth holding a caller's request open for, so it gives up. **400, 401 and 403 are never retried.**
- **Worst case.** A model that times out every time can hold one request for about 2 minutes (four 30-second attempts plus the waits), and a repair call can double that. Lower `LLM_MAX_RETRIES` or `LLM_TIMEOUT_MS` if that is too long.
- **Cost log.** Every live request writes one JSON line to standard output with the prompt version, model, input tokens, output tokens, duration in milliseconds, number of HTTP requests and retries, whether a repair was needed, and the outcome (`ok`, `invalid_output`, `timeout`, `rate_limited`, `auth_error`, and so on). Tokens are summed across the first call and the repair call. Each retry also logs its own `llm_retry` line.
- **Latency.** With Gemini's default thinking, three live calls to `gemini-3.1-flash-lite` took 23.8, 18.9 and 21.9 seconds for about 616 input and 36 to 40 output tokens, close to the 30-second timeout. Setting `LLM_REASONING_EFFORT=minimal` (passed to Gemini as `reasoning_effort`) cut two calls to 1.9 and 1.5 seconds with the same reported output tokens, so the extra time was hidden thinking, which the output token count does not include. That also means the token counts in the cost log undercount Gemini's real output when thinking is on. The setting is only sent when set, so other providers are unaffected.
- **Kill switch.** Set `LLM_ENABLED=false` and restart: the endpoint skips the model entirely and answers at once with a deterministic fallback (`category: other`, `urgency: normal`, `confidence: 0`, and a reason saying AI triage is off), so downstream code keeps working and a human reviews the message. The logs then show an `llm_disabled` line and no model calls.

To check the retry rules, error mapping and kill switch without calling the model, run `node scripts/check-stage4.js`.

## POST /triage

Classifies one support message. It requires a logged-in user: get a Bearer token from `POST /auth/login` first. The input and output shapes are in [JOB-CARD.md](JOB-CARD.md).

### Try it in 5 seconds (stub mode, no model call)

Set `LLM_STUB=1` in `.env`, restart the server, and replace `$TOKEN` with the `access_token` from `/auth/login`.

**Valid request (expect 200 and JSON in the job-card shape):**

```bash
curl -X POST http://localhost:3000/triage \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "I was charged twice for my subscription this month."}'
```

**Deliberately broken request (expect 400 naming the field `text`):**

```bash
curl -X POST http://localhost:3000/triage \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": 123}'
```

On Windows PowerShell, use `curl.exe` and pass the JSON from a file (`-d "@body.json"`), because plain `curl` is a different command there.
