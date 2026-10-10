// Import Zod, the library that defines the shape of our data and refuses anything that does not match
const { z } = require('zod');

// The closed list of allowed categories, copied from JOB-CARD.md
const CATEGORIES = ['billing', 'bug', 'feature', 'other'];
// The closed list of allowed urgency levels, copied from JOB-CARD.md
const URGENCIES = ['low', 'normal', 'high'];
// The longest message we accept, so one request cannot send an unbounded amount of text to the model
const MAX_TEXT_LENGTH = 2000;

// The shape of the request body: exactly one field called text
const triageInputSchema = z.object({
  // text must be a string, at least 1 character, at most 2000 characters
  text: z
    // Reject numbers, arrays, objects and missing values with a clear message
    .string({ message: 'text must be a string' })
    // Remove spaces at both ends so whitespace-only messages count as empty
    .trim()
    // Require at least one real character
    .min(1, 'text must not be empty')
    // Enforce the length limit from the job card
    .max(MAX_TEXT_LENGTH, `text must be at most ${MAX_TEXT_LENGTH} characters`),
// End of the input schema
});

// The shape of the response we promise callers: the same four fields every single time
const triageOutputSchema = z
  // Build an object schema
  .object({
    // category must be exactly one of the allowed values
    category: z.enum(CATEGORIES),
    // urgency must be exactly one of the allowed values
    urgency: z.enum(URGENCIES),
    // confidence must be a number between 0 and 1 inclusive
    confidence: z.number().min(0).max(1),
    // reason is the only free-text field, kept to one short sentence
    reason: z.string().min(1).max(300),
  // End of the object's field list
  })
  // Reject any extra fields so the model cannot smuggle in additional data
  .strict();

// A hard-coded valid answer used when LLM_STUB=1, so we can build without calling the model
const STUB_RESPONSE = {
  // A typical category
  category: 'other',
  // A middle urgency
  urgency: 'normal',
  // A low confidence, because a stub is not a real judgement
  confidence: 0.3,
  // A clear sign this answer is fake
  reason: 'Stub response: the model was not called.',
// End of the stub answer
};

// Export everything the route and later stages need
module.exports = {
  // The input schema
  triageInputSchema,
  // The output schema
  triageOutputSchema,
  // The stub answer
  STUB_RESPONSE,
  // The category list, reused by the prompt and the eval script later
  CATEGORIES,
  // The urgency list, reused by the prompt and the eval script later
  URGENCIES,
  // The length limit, reused in documentation
  MAX_TEXT_LENGTH,
// End of the exports
};
