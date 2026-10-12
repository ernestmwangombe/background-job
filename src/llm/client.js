// Import the OpenAI client class; it also talks to Gemini because Gemini copies the same request shape
const { OpenAI } = require('openai');

// Keep one client for the whole process; it is created on first use so stub mode never needs a key
let client = null;

// Read the request timeout; default 30 seconds, never more than 60 (the SDK default of 10 minutes is not a real timeout)
function getTimeoutMs() {
  // Take the optional override from the environment
  const raw = Number(process.env.LLM_TIMEOUT_MS);
  // Use the default when the setting is missing, empty, zero or not a number
  if (!Number.isFinite(raw) || raw <= 0) {
    // 30 seconds
    return 30000;
  // End of the default branch
  }
  // Clamp to 60 seconds at most
  return Math.min(raw, 60000);
// End of getTimeoutMs
}

// Return the shared client, creating it the first time
function getClient() {
  // Reuse the existing client if there is one
  if (client) {
    // Hand back the cached client
    return client;
  // End of the cache check
  }
  // Read the three provider settings from the environment, so no provider is hard-coded
  const { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL } = process.env;
  // If any setting is missing the model cannot be called
  if (!LLM_BASE_URL || !LLM_API_KEY || !LLM_MODEL) {
    // Build an error that names the problem without printing any value
    const err = new Error('LLM_BASE_URL, LLM_API_KEY and LLM_MODEL must all be set');
    // Tag the error so the route can answer 503 instead of a generic failure
    err.code = 'LLM_NOT_CONFIGURED';
    // Stop here
    throw err;
  // End of the settings check
  }
  // Create the client pointed at whichever provider the environment names
  client = new OpenAI({
    // Where requests are sent (Gemini, OpenRouter or Ollama)
    baseURL: LLM_BASE_URL,
    // The secret key from .env
    apiKey: LLM_API_KEY,
    // Give up after this many milliseconds instead of waiting for the SDK default
    timeout: getTimeoutMs(),
    // The SDK's own silent retries are OFF; src/llm/retry.js is the only retry logic, so one request is exactly one call
    maxRetries: 0,
  // End of the client options
  });
  // Hand back the new client
  return client;
// End of getClient
}

// Export the function for the model call
module.exports = { getClient };
