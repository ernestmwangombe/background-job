// Import Express so we can build a router that server.js mounts at /triage
const express = require('express');
// Import the schemas and the stub and fallback answers
const { triageInputSchema, triageOutputSchema, STUB_RESPONSE, FALLBACK_RESPONSE } = require('../llm/schema');
// Import the function that asks the model, validates the answer and repairs it once, plus the cost meter
const { classifyMessage, createMeter } = require('../llm/triageModel');
// Import the function that sets failed answers aside in a log file
const { quarantine } = require('../llm/quarantine');
// Import the prompt version so failed calls can still be logged with it
const { PROMPT_VERSION } = require('../llm/prompt');
// Import the kill-switch check
const { isLlmEnabled } = require('../llm/killSwitch');
// Import the structured logger
const { logEvent } = require('../llm/log');
// Import the mapping from model-call errors to outcome names and HTTP answers
const { describeError } = require('../llm/errors');

// Create a router; server.js mounts it behind requireAuth, so only logged-in users reach this code
const router = express.Router();

// Handle POST /triage (the router is mounted at /triage, so the path here is /); async because the model call waits
router.post('/', async (req, res) => {
  // Validate the request body before doing anything else; every rejected request is a model call we never pay for
  const parsed = triageInputSchema.safeParse(req.body);

  // If the body is invalid, answer 400 and name the offending field
  if (!parsed.success) {
    // Turn each Zod issue into a small object that names the field and explains the problem
    const details = parsed.error.issues.map((issue) => ({
      // Join the path so the field is always named, defaulting to text
      field: issue.path.join('.') || 'text',
      // The human-readable reason
      message: issue.message,
    // End of the detail object
    }));
    // Return the 400 with a stable JSON shape
    return res.status(400).json({ error: 'Validation Failed', details });
  // End of the invalid-body branch
  }

  // Kill switch: when LLM_ENABLED=false, skip the model entirely and answer at once with the safe fallback
  if (!isLlmEnabled()) {
    // Log that the model was skipped, so the logs show zero model calls
    logEvent('llm_disabled', { reason: 'LLM_ENABLED=false' });
    // Check the fallback against the output schema too, so the contract holds even when the model is off
    const fallback = triageOutputSchema.parse(FALLBACK_RESPONSE);
    // Return 200 with the deterministic fallback
    return res.status(200).json(fallback);
  // End of the kill-switch branch
  }

  // Stub mode: skip the model completely and return a hard-coded, schema-valid answer
  if (process.env.LLM_STUB === '1') {
    // Check the stub against the output schema too, so the contract is enforced even for fake data
    const checked = triageOutputSchema.parse(STUB_RESPONSE);
    // Return 200 with the stub answer
    return res.status(200).json(checked);
  // End of the stub-mode branch
  }

  // Live mode: remember when we started and prepare a meter that counts requests, retries and tokens
  const startedAt = Date.now();
  // The meter is filled in by the model call
  const meter = createMeter();
  // Write one structured log line for this request: what it cost and how it ended
  const logCall = (fields) => logEvent('llm_call', {
    // Which prompt version was used
    promptVersion: PROMPT_VERSION,
    // Which model was used
    model: process.env.LLM_MODEL,
    // Tokens sent to the model across all attempts
    inputTokens: meter.inputTokens,
    // Tokens received from the model across all attempts
    outputTokens: meter.outputTokens,
    // How long the whole request took in milliseconds
    durationMs: Date.now() - startedAt,
    // How many HTTP requests were sent, including retries
    requests: meter.requests,
    // How many of those were retries
    retries: meter.retries,
    // Outcome, repaired flag and any status come from the caller
    ...fields,
  // End of the log line
  });

  // Ask the model, and never let a failure crash the process
  try {
    // Send the validated, trimmed message to the model; this validates the answer and repairs it once if needed
    const result = await classifyMessage(parsed.data.text, { meter });
    // If we have a schema-valid answer, log it and return only that clean object
    if (result.ok) {
      // Log the successful call and whether it needed a repair
      logCall({ outcome: 'ok', repaired: result.repaired });
      // Return 200 with the validated classification (never the raw model text)
      return res.status(200).json(result.data);
    // End of the success branch
    }
    // The model failed validation twice: log it, then set the attempt aside with its input, errors, raw output and prompt version
    logCall({ outcome: 'invalid_output', repaired: true });
    // Write the quarantine entry
    quarantine({
      // The customer's message that caused the failure
      input: parsed.data.text,
      // The reason the final attempt was rejected
      error: result.error,
      // The reason each attempt was rejected
      errors: result.errors,
      // The raw model text from each attempt (log only, never returned to callers)
      rawOutputs: result.rawOutputs,
      // Which prompt version produced them
      promptVersion: result.promptVersion,
      // Which model produced them
      model: process.env.LLM_MODEL,
    // End of the quarantine entry
    });
    // Answer 422: the request was understood but no valid result could be produced
    return res.status(422).json({
      // A short error label
      error: 'Unprocessable Entity',
      // A clear message that contains no model text
      message: 'The model could not produce a valid classification for this message. The attempt was logged for review.',
    // End of the 422 response body
    });
  // End of the try block
  } catch (err) {
    // Work out the outcome name and the HTTP answer for this failure
    const info = describeError(err);
    // Log the call with its outcome, the provider's status, and whether more than one answer was obtained
    logCall({ outcome: info.outcome, status: typeof err?.status === 'number' ? err.status : null, repaired: false });
    // Print a clear line for the person running the server; the key is never part of an error message
    console.error('[triage] model call failed:', info.outcome, err?.status ?? 'no-status', err?.message);
    // Return the mapped HTTP answer: 504 for timeouts, 503 for rate limits and missing config, 502 for other provider failures
    return res.status(info.httpStatus).json({ error: info.error, message: info.message });
  // End of the catch block
  }
// End of the POST handler
});

// Export the router so server.js can mount it
module.exports = router;
