# background-job

An Express API with Supabase login and one protected endpoint, `POST /triage`, that reads a support message and says which team it belongs to and how urgent it is.

> Work in progress for FlyRank Week 7 (A17, "Put an LLM behind your API"). This README is completed in Stage 5.

## Setup

1. Install packages: `npm install`
2. Copy `.env.example` to `.env` and fill in your own values (never commit `.env`).
3. Start the server: `node server.js`

## Provider settings

Three environment variables are the only difference between a model running on your laptop and one running in a datacentre, so no provider is ever hard-coded: `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL`. This project currently uses Gemini through its OpenAI-compatible endpoint.

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
