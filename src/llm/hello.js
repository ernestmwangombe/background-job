// Load variables from .env into process.env (same call server.js uses)
require('dotenv').config();
// Import the OpenAI client class; it also works with Gemini because Gemini copies the same request shape
const { OpenAI } = require('openai');

// Read the three provider settings from the environment so no provider is hard-coded
const { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL } = process.env;

// Stop early with a clear message if any of the three settings is missing
if (!LLM_BASE_URL || !LLM_API_KEY || !LLM_MODEL) {
  // Name the missing settings without ever printing the key itself
  console.error('Missing LLM_BASE_URL, LLM_API_KEY or LLM_MODEL in .env');
  // Exit with a failure code so scripts can detect the problem
  process.exit(1);
// End of the missing-settings check
}

// Create the client pointed at whichever provider the environment names
const client = new OpenAI({
  // Where requests are sent (Gemini, OpenRouter or Ollama)
  baseURL: LLM_BASE_URL,
  // The secret key from .env
  apiKey: LLM_API_KEY,
  // Give up after 30 seconds instead of the SDK default of 10 minutes
  timeout: 30000,
  // Do not retry automatically, so one failed run costs exactly one request
  maxRetries: 0,
// End of the client options
});

// Wrap the call in an async function so await can be used
async function main() {
  // Send one chat request asking for a single known word
  const res = await client.chat.completions.create({
    // Which model to use, taken from .env
    model: LLM_MODEL,
    // A single user message, the simplest possible conversation
    messages: [{ role: 'user', content: 'Reply with exactly the word: ready' }],
  // End of the request options
  });
  // Print the model's answer, or an empty string if the shape is unexpected
  console.log(res.choices?.[0]?.message?.content ?? '');
// End of the main function
}

// Run the function and handle any failure without crashing ugly
main().catch((err) => {
  // Print the HTTP status (for example 401 or 429) and the provider's message, never the key
  console.error(`Request failed: status=${err.status ?? 'none'} message=${err.message}`);
  // Exit with a failure code
  process.exit(1);
// End of the error handler
});
