// Import the function that returns the shared model client
const { getClient } = require('./client');
// Import the prompt text and its version name
const { SYSTEM_PROMPT, PROMPT_VERSION } = require('./prompt');

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

// Send one support message to the model and return its raw text reply
async function classifyMessage(text) {
  // Call the chat completions endpoint through the shared client
  const res = await getClient().chat.completions.create({
    // Which model to use, taken from .env
    model: process.env.LLM_MODEL,
    // Low temperature for repeatable answers
    temperature: getTemperature(),
    // The conversation: instructions first, then the customer's data
    messages: [
      // The system message holds only our instructions, never the customer's text
      { role: 'system', content: SYSTEM_PROMPT },
      // The user message holds the customer's text as JSON, so quotes in it cannot break out of their string
      { role: 'user', content: JSON.stringify({ text }) },
    // End of the messages list
    ],
  // End of the request options
  });
  // Return the reply text (empty if the provider sent none) and the prompt version that produced it
  return { rawText: res.choices?.[0]?.message?.content ?? '', promptVersion: PROMPT_VERSION };
// End of classifyMessage
}

// Export the function for the route
module.exports = { classifyMessage };
