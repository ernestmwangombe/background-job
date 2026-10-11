// Import the function that returns the shared model client
const { getClient } = require('./client');
// Import the prompt text and its version name
const { SYSTEM_PROMPT, PROMPT_VERSION } = require('./prompt');
// Import the parser and validator that check every answer against the schema
const { parseAndValidate } = require('./parseOutput');

// The longest piece of a bad answer we send back to the model or write to the log
const MAX_RAW_LENGTH = 4000;

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

// Send a list of messages to the model and return its raw text reply
async function callModel(messages) {
  // Call the chat completions endpoint through the shared client
  const res = await getClient().chat.completions.create({
    // Which model to use, taken from .env
    model: process.env.LLM_MODEL,
    // Low temperature for repeatable answers
    temperature: getTemperature(),
    // The conversation so far
    messages,
  // End of the request options
  });
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

// Classify one message: ask once, validate, repair once if needed, then give up cleanly; "call" can be swapped in tests
async function classifyMessage(text, { call = callModel } = {}) {
  // The base conversation: our instructions, then the customer's text as JSON in a separate user message
  const baseMessages = [
    // The system message holds only our instructions, never the customer's text
    { role: 'system', content: SYSTEM_PROMPT },
    // The user message holds the customer's text as JSON, so quotes in it cannot break out of their string
    { role: 'user', content: JSON.stringify({ text }) },
  // End of the base messages
  ];

  // Attempt 1: ask the model
  const firstRaw = await call(baseMessages);
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
  const secondRaw = await call(repairMessages);
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

// Export the function for the route and the self-test
module.exports = { classifyMessage };
