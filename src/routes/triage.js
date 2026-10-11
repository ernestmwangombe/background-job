// Import Express so we can build a router that server.js mounts at /triage
const express = require('express');
// Import the schemas and the stub answer defined in Stage 1
const { triageInputSchema, triageOutputSchema, STUB_RESPONSE } = require('../llm/schema');
// Import the function that sends a message to the model (Stage 2)
const { classifyMessage } = require('../llm/triageModel');

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

  // Stub mode: skip the model completely and return a hard-coded, schema-valid answer
  if (process.env.LLM_STUB === '1') {
    // Check the stub against the output schema too, so the contract is enforced even for fake data
    const checked = triageOutputSchema.parse(STUB_RESPONSE);
    // Return 200 with the stub answer
    return res.status(200).json(checked);
  // End of the stub-mode branch
  }

  // Live mode: ask the model, and never let a failure crash the process
  try {
    // Send the validated, trimmed message to the model
    const { rawText, promptVersion } = await classifyMessage(parsed.data.text);
    // STAGE 2 ONLY: the assignment says to return the raw reply for now; Stage 3 replaces this with parsed, validated JSON
    return res.status(200).json({ stage: 2, prompt_version: promptVersion, raw_model_text: rawText });
  // End of the try block
  } catch (err) {
    // A missing provider setting is a server configuration problem, not a model failure
    if (err.code === 'LLM_NOT_CONFIGURED') {
      // Tell the caller the feature is unavailable without naming any setting values
      return res.status(503).json({ error: 'Service Unavailable', message: 'The model is not configured on the server.' });
    // End of the not-configured branch
    }
    // Log the HTTP status and message on the server only; the key is never part of this message
    console.error('[triage] model call failed:', err.status ?? 'no-status', err.message);
    // Return a generic error so provider details never leak to callers; Stage 4 refines this into 504 and retries
    return res.status(502).json({ error: 'Bad Gateway', message: 'The model call failed.' });
  // End of the catch block
  }
// End of the POST handler
});

// Export the router so server.js can mount it
module.exports = router;
