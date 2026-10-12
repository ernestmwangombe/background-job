// Import the function that returns the shared model client
const { getClient } = require('./client');
// Import the prompt text and its version name
const { SYSTEM_PROMPT, PROMPT_VERSION } = require('./prompt');
// Import the parser and validator that check every answer against the schema
const { parseAndValidate } = require('./parseOutput');
// Import the retry loop that retries only timeouts, 429 and 5xx
const { withRetry } = require('./retry');
// Import the structured logger
const { logEvent } = require('./log');

// The longest piece of a bad answer we send back to the model or write to the log
const MAX_RAW_LENGTH = 4000;

// Create a fresh meter that counts what one request cost
function createMeter() {
  // requests = every HTTP request sent (including retries); retries = how many were retries; tokens come from the provider
  return { requests: 0, retries: 0, inputTokens: 0, outputTokens: 0 };
// End of createMeter
}

// Read the temperature setting; the assignment asks for low (0 or 0.2) so the same input gives the same answer
function getTemperature() {
  // Take the optional override from the environment
  const raw = process.env.LLM_TEMPERATURE;
  // Turn it into a number if one was given
  const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
  // Use the override when valid, otherwise the low default of 0.2
  return Number.isNaN(parsed) ? 0.2 : parsed;
// End of getTemperature
}

// Read how many retries are allowed per model call; default 3 gives waits of about 1s, 2s and 4s
function getMaxRetries() {
  // Take the optional override from the environment
  const parsed = Number.parseInt(process.env.LLM_MAX_RETRIES ?? '', 10);
  // Use the default when missing or invalid, and never allow more than 5
  return Number.isNaN(parsed) || parsed < 0 ? 3 : Math.min(parsed, 5);
// End of getMaxRetries
}

// Build the request body from the messages and the current settings; kept separate so it can be tested without a network
function buildRequest(messages) {
  // The settings every request needs
  const request = {
    // Which model to use, taken from .env
    model: process.env.LLM_MODEL,
    // Low temperature for repeatable answers
    temperature: getTemperature(),
    // The conversation so far
    messages,
  // End of the base request
  };
  // Optional: how hard the model should "think" before answering (Gemini accepts minimal or low); unset means the model's default
  const effort = (process.env.LLM_REASONING_EFFORT ?? '').trim();
  // Only send the field when it is set, so providers that do not know it are never sent it
  if (effort) {
    // Add the field to the request
    request.reasoning_effort = effort;
  // End of the optional-effort branch
  }
  // Hand back the finished request
  return request;
// End of buildRequest
}

// Send a list of messages to the model and return its raw text reply; failures are retried only when retrying can help
async function callModel(messages, meter = createMeter()) {
  // Run the request inside the retry loop
  const res = await withRetry(
    // One attempt: count it, then send it
    () => {
      // Count this HTTP request, whether it succeeds or not
      meter.requests += 1;
      // Call the chat completions endpoint through the shared client, using the request built from the current settings
      return getClient().chat.completions.create(buildRequest(messages));
    // End of one attempt
    },
    // Retry settings
    {
      // How many retries are allowed
      maxRetries: getMaxRetries(),
      // Called before each wait, so retries are counted and visible in the logs
      onRetry: (info) => {
        // Count the retry
        meter.retries += 1;
        // Log it as its own line
        logEvent('llm_retry', info);
      // End of the onRetry callback
      },
    // End of the retry settings
    },
  // End of the withRetry call
  );
  // Add the provider's token counts to the meter (missing counts are treated as zero)
  meter.inputTokens += res.usage?.prompt_tokens ?? 0;
  // Add the output tokens too
  meter.outputTokens += res.usage?.completion_tokens ?? 0;
  // Return the reply text, or an empty string if the provider sent none
  return res.choices?.[0]?.message?.content ?? '';
// End of callModel
}

// Build the message that tells the model exactly why its last answer was rejected
function repairInstruction(error) {
  // Quote the exact validation error and ask for corrected JSON only
  return `Your previous answer was rejected for this reason: ${error}. Return only corrected JSON matching the schema.`;
// End of repairInstruction
}

// Classify one message: ask once, validate, repair once if needed, then give up cleanly; "call" and "meter" can be swapped in tests
async function classifyMessage(text, { call = callModel, meter = createMeter() } = {}) {
  // The base conversation: our instructions, then the customer's text as JSON in a separate user message
  const baseMessages = [
    // The system message holds only our instructions, never the customer's text
    { role: 'system', content: SYSTEM_PROMPT },
    // The user message holds the customer's text as JSON, so quotes in it cannot break out of their string
    { role: 'user', content: JSON.stringify({ text }) },
  // End of the base messages
  ];

  // Attempt 1: ask the model
  const firstRaw = await call(baseMessages, meter);
  // Check the answer against the schema
  const first = parseAndValidate(firstRaw);
  // If it is valid, we are done and no repair was needed
  if (first.ok) {
    // Return the clean data
    return { ok: true, data: first.data, repaired: false, promptVersion: PROMPT_VERSION };
  // End of the first-success branch
  }

  // Attempt 2 (the one and only repair): same conversation, plus the broken answer and the exact error
  const repairMessages = [
    // Everything from the first attempt
    ...baseMessages,
    // The model's own rejected answer, shortened if it is huge and never empty (some providers reject empty messages)
    { role: 'assistant', content: firstRaw.slice(0, MAX_RAW_LENGTH) || '(empty reply)' },
    // The reason it was rejected and what to do about it
    { role: 'user', content: repairInstruction(first.error) },
  // End of the repair messages
  ];
  // Ask the model one more time
  const secondRaw = await call(repairMessages, meter);
  // Check the second answer against the schema
  const second = parseAndValidate(secondRaw);
  // If the repair worked, return the clean data and note that a repair was needed
  if (second.ok) {
    // Return the corrected data
    return { ok: true, data: second.data, repaired: true, promptVersion: PROMPT_VERSION };
  // End of the repair-success branch
  }

  // Both attempts failed: give up cleanly and hand back what the quarantine log needs
  return {
    // Signal failure to the route
    ok: false,
    // A repair was attempted
    repaired: true,
    // The reason the final attempt failed
    error: second.error,
    // The reason each attempt failed
    errors: [first.error, second.error],
    // The raw text of each attempt, shortened, for the quarantine log only (never sent to callers)
    rawOutputs: [firstRaw.slice(0, MAX_RAW_LENGTH), secondRaw.slice(0, MAX_RAW_LENGTH)],
    // Which prompt produced them
    promptVersion: PROMPT_VERSION,
  // End of the failure result
  };
// End of classifyMessage
}

// Export what the route and the self-tests need
module.exports = { classifyMessage, createMeter, buildRequest };
