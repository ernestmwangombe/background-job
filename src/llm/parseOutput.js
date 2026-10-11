// Import the output schema defined in Stage 1, which is the contract for every answer
const { triageOutputSchema } = require('./schema');

// Remove a surrounding markdown code fence such as ```json ... ``` if the model added one
function stripCodeFence(text) {
  // Look for text wrapped in triple backticks, with an optional "json" label after the opening fence
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  // Use the text inside the fence when there is one, otherwise keep the original text
  return fenced ? fenced[1] : text;
// End of stripCodeFence
}

// Find the JSON object inside a reply that might also contain chatty text such as "Sure! Here is the JSON:"
function extractJsonObject(text) {
  // First remove any code fence around the object
  const cleaned = stripCodeFence(text);
  // The object starts at the first opening brace
  const start = cleaned.indexOf('{');
  // The object ends at the last closing brace
  const end = cleaned.lastIndexOf('}');
  // If either brace is missing, or they are in the wrong order, there is no object to parse
  if (start === -1 || end === -1 || end < start) {
    // Signal "nothing found"
    return null;
  // End of the no-object branch
  }
  // Return just the text from the first brace to the last brace
  return cleaned.slice(start, end + 1);
// End of extractJsonObject
}

// Turn Zod's list of problems into one readable sentence the model (and a human) can act on
function formatIssues(issues) {
  // Describe each problem as "field: message" and join them with semicolons
  return issues.map((issue) => `${issue.path.join('.') || 'reply'}: ${issue.message}`).join('; ');
// End of formatIssues
}

// Parse the model's raw text and check it against the schema; never throws
function parseAndValidate(rawText) {
  // Make sure we are working with a string even if the provider sent nothing
  const candidate = extractJsonObject(String(rawText ?? ''));
  // If no object was found, this attempt failed
  if (candidate === null) {
    // Report the failure with a reason
    return { ok: false, error: 'No JSON object found in the reply' };
  // End of the no-object branch
  }
  // Hold the parsed value here
  let parsed;
  // JSON.parse throws on bad syntax, so guard it
  try {
    // Turn the JSON text into a JavaScript value
    parsed = JSON.parse(candidate);
  // End of the try block
  } catch (err) {
    // Report the syntax problem instead of crashing
    return { ok: false, error: `Reply is not valid JSON: ${err.message}` };
  // End of the catch block
  }
  // Check the parsed value against the schema: right fields, allowed values, confidence between 0 and 1
  const result = triageOutputSchema.safeParse(parsed);
  // If the shape or values are wrong, this attempt failed
  if (!result.success) {
    // Report exactly what was wrong
    return { ok: false, error: formatIssues(result.error.issues) };
  // End of the invalid-shape branch
  }
  // Success: return the schema-checked data, never the raw text
  return { ok: true, data: result.data };
// End of parseAndValidate
}

// Export the function for the model call and the self-test
module.exports = { parseAndValidate };
