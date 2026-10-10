// Import Express so we can build a router that server.js mounts at /triage
const express = require('express');
// Import the schemas and the stub answer defined in Stage 1
const { triageInputSchema, triageOutputSchema, STUB_RESPONSE } = require('../llm/schema');

// Create a router; server.js mounts it behind requireAuth, so only logged-in users reach this code
const router = express.Router();

// Handle POST /triage (the router is mounted at /triage, so the path here is /)
router.post('/', (req, res) => {
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

  // Stage 2 will call the model here; until then, say so clearly instead of pretending
  return res.status(501).json({
    // A short error label
    error: 'Not Implemented',
    // Tell the caller how to get an answer in the meantime
    message: 'The model is not wired up yet. Set LLM_STUB=1 to receive a stub response.',
  // End of the 501 response body
  });
// End of the POST handler
});

// Export the router so server.js can mount it
module.exports = router;
