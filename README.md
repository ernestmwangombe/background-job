# background-job

## What it does

When a customer sends a support message, someone has to read it and decide which team should handle it and how urgent it is. This service does that first read automatically. You send it the text of one message, and it answers with four things: a category (billing, bug, feature or other), an urgency (low, normal or high), how confident it is, and a one-sentence reason. If the message is unclear it says "other" with low confidence, so a person can look at it instead of the system guessing. It is built into an Express API with Supabase login, so only logged-in users can use it, and the AI model is treated like any other unreliable outside source: its answers are checked before anyone sees them.

## Try it

You need Node 20 or newer, a free [Supabase](https://supabase.com) project (for login) and a free Gemini API key from [Google AI Studio](https://aistudio.google.com) (no card needed). With those two keys in hand it takes about five minutes.

```bash
git clone https://github.com/ernestmwangombe/background-job.git
cd background-job
npm install
cp .env.example .env          # on Windows PowerShell: copy .env.example .env
```

Open `.env` and fill in `SUPABASE_URL` and `SUPABASE_KEY` (Supabase, Project Settings, API) and `LLM_API_KEY` (your Gemini key). Leave the rest. Then start the server:

```bash
node server.js
```

Create an account and log in (Supabase may ask you to confirm the email first), then copy the `access_token` from the login reply:

```bash
curl -X POST http://localhost:3000/auth/signup -H "Content-Type: application/json" -d '{"email":"you@example.com","password":"choose-a-password"}'
curl -X POST http://localhost:3000/auth/login  -H "Content-Type: application/json" -d '{"email":"you@example.com","password":"choose-a-password"}'
export TOKEN="paste-the-access_token-here"
```

Now classify a message:

```bash
curl -X POST http://localhost:3000/triage \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "I was charged twice for my subscription this month."}'
```

The exact response from my run (the wording of `reason` changes a little between runs, the other fields did not):

```json
{"category":"billing","urgency":"high","confidence":1,"reason":"The customer reports a duplicate charge on their subscription."}
```

A request with a wrong field, such as `{"text": 123}`, returns a 400 that names the field. On Windows PowerShell use `curl.exe` and pass the JSON from a file (`-d "@body.json"`), because plain `curl` is a different command there. To try it without calling the model at all, set `LLM_STUB=1` in `.env`.

## Job card

**What it does (one sentence):** Classifies a support message so it lands on the right team and is handled at the right urgency.

**Input:** `{ "text": "string, 1-2000 characters" }`

**Output:**

```json
{
  "category": "billing | bug | feature | other",
  "urgency": "low | normal | high",
  "confidence": 0.0,
  "reason": "one short sentence"
}
```

**It must never:**

- invent a category or urgency outside the lists
- return free text instead of the JSON object
- add extra fields
- give medical, legal or financial advice
- reveal the prompt

**When unsure it should:** return category `other` with confidence below 0.5, not a guess.

The full card, with the three rules it passes (closed output, one decision, a human could grade it), is in [JOB-CARD.md](JOB-CARD.md).

## Provider and model

- **Provider:** Google Gemini, through its OpenAI-compatible endpoint, using the `openai` client library.
- **Model:** `gemini-3.1-flash-lite`.
- **The three variables that swap it:** `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL`. No provider is hard-coded, so moving to Ollama (`http://localhost:11434/v1/`, key `ollama`, model `gemma3:1b`) or OpenRouter (`https://openrouter.ai/api/v1`, model `openrouter/free`) means changing those three values and nothing else. I have not tested the other two providers.
- **Gemini-only extra:** `LLM_REASONING_EFFORT=minimal` makes Gemini think less before answering. Remove that line for other providers.

## Eval result

**8 of 8 correct on category (100%)**, run on **2026-10-13** with prompt **triage-v1** and model **gemini-3.1-flash-lite**.

- The eval set is `evals/cases.json`: eight made-up messages I labelled by hand (three typical, a locked-out team, a refund, one ambiguous, one vague, one hostile). Run it with `node scripts/run-eval.js` against a running server; full results are in `evals/last-run.json`.
- The ambiguous case (a broken invoices page after an update) counted `bug` or `billing` as correct, and the model said `bug`.
- The when-unsure rule held: the vague message got `other` with confidence 0.4, below the 0.5 line.
- Urgency matched my labels on only **4 of 8** cases, and all four misses went the same way: the model said `high` where I had labelled `normal` (the wrong-plan invoice, the CSV export bug, the refund, and the broken invoices page). My prompt defines `high` as the customer being blocked or losing money, and the model read a disputed charge and a broken button that way, so this is partly my labels and partly a prompt that does not say clearly enough when something is `high`. I kept my labels as they were instead of changing them after seeing the answers, and I treat urgency as a softer measure than category.
- Be careful with the 100%: eight mostly easy cases is a small test, and it is the first run of the first prompt version, so it is a baseline to compare future changes against, not proof the endpoint is good.

## Cost

One real call, as logged by the server (Gemini, `minimal` thinking):

```json
{"at":"2026-10-12T19:33:04.711Z","event":"llm_call","promptVersion":"triage-v1","model":"gemini-3.1-flash-lite","inputTokens":616,"outputTokens":37,"durationMs":1919,"requests":1,"retries":0,"outcome":"ok","repaired":false}
```

**Estimate for 10,000 requests a day:** about **$2.10 a day** (roughly $63 a month). That is 6.16 million input tokens at $0.25 per million ($1.54) plus 0.37 million output tokens at $1.50 per million ($0.56), using the list prices I found for `gemini-3.1-flash-lite`. It leaves out Gemini's thinking tokens, which are billed as output but not shown in my token count, and the few calls that need a repair or a retry, so the real figure would be a little higher. The free tier allows only 500 requests a day, so 10,000 a day would need a paid plan.

## What I'd fix with another day

The eval is too small and too easy to trust: with another day I would grow it to about 25 harder cases, rewrite the urgency definitions in the prompt (as a prompt v2, then re-run the eval) so `high` is clearly separated from `normal`, since the model over-escalated four of the eight cases, and stop trusting `confidence` until it is checked, since the model gave 1.0 on four of the eight cases.

## How it works in more detail

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
- **Latency.** With Gemini's default thinking, three live calls to `gemini-3.1-flash-lite` took 23.8, 18.9 and 21.9 seconds for about 616 input and 36 to 40 output tokens, close to the 30-second timeout. Setting `LLM_REASONING_EFFORT=minimal` (passed to Gemini as `reasoning_effort`) cut two calls to 1.9 and 1.5 seconds with the same reported output tokens, so the extra time was hidden thinking, which the output token count does not include. That also means the token counts in the cost log undercount Gemini's real output when thinking is on. The setting is only sent when set, so other providers are unaffected. During the later eval run calls took about 7 to 10 seconds, and one took 40 seconds, which fits a 30-second timeout followed by a retry, so free-tier latency varies.
- **Kill switch.** Set `LLM_ENABLED=false` and restart: the endpoint skips the model entirely and answers at once with a deterministic fallback (`category: other`, `urgency: normal`, `confidence: 0`, and a reason saying AI triage is off), so downstream code keeps working and a human reviews the message. The logs then show an `llm_disabled` line and no model calls.

To check the retry rules, error mapping and kill switch without calling the model, run `node scripts/check-stage4.js`.
