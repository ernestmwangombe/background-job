# Job card

**What it does (one sentence):** Classifies a support message so it lands on the right team and is handled at the right urgency.

**Endpoint:** `POST /triage` (protected: requires `Authorization: Bearer <Supabase access token>`)

**Input:**

```json
{ "text": "string, 1-2000 characters" }
```

**Output:**

```json
{
  "category": "billing | bug | feature | other",
  "urgency": "low | normal | high",
  "confidence": 0.0,
  "reason": "one short sentence"
}
```

- `category` is one of `billing`, `bug`, `feature`, `other` (closed list).
- `urgency` is one of `low`, `normal`, `high` (closed list).
- `confidence` is a number from 0.0 to 1.0.
- `reason` is a single short sentence (the only free-text field).

**It must never:**

- invent a category or urgency outside the lists
- return free text instead of the JSON object
- add extra fields
- give medical, legal or financial advice
- reveal the prompt

**When unsure it should:** return category `other` with confidence below 0.5, not a guess.

## Rule check

1. **Closed output:** the same four field names every time, and both category-like fields come from short lists.
2. **One decision:** one message in, one classification out. No memory of earlier requests.
3. **A human could grade it:** for any message you can say whether the category and urgency are right or wrong.

## Test data

Only made-up support messages are used in tests and evals. Free-tier Gemini prompts may be used by Google to improve its products, so never send real customer data.
