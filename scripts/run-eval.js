// Eval runner: sends every case in evals/cases.json to your running /triage endpoint and prints how many matched
// Load variables from .env (the same file the server uses)
require('dotenv').config();
// Import Node's file-system module to read the cases and save the results
const fs = require('fs');
// Import Node's path module so file locations work on Windows and Linux
const path = require('path');
// Import the prompt version so the result says which prompt it measured
const { PROMPT_VERSION } = require('../src/llm/prompt');

// Where the running server listens; override with EVAL_BASE_URL if needed
const BASE_URL = (process.env.EVAL_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
// The least time between request starts: Gemini's free tier allows 15 requests a minute, so one every 4.5 seconds stays safely under it
const MIN_INTERVAL_MS = Number(process.env.EVAL_INTERVAL_MS) > 0 ? Number(process.env.EVAL_INTERVAL_MS) : 4500;
// The longest we wait for one answer; the server's own worst case with retries is about two minutes
const REQUEST_TIMEOUT_MS = 150000;
// The confidence below which the prompt's "when unsure" rule says the model should stay
const LOW_CONFIDENCE = 0.5;

// Wait for the given number of milliseconds
function sleep(ms) {
  // Resolve after a real timer
  return new Promise((resolve) => setTimeout(resolve, ms));
// End of sleep
}

// Get a login token: use EVAL_TOKEN if given, otherwise log in with EVAL_EMAIL and EVAL_PASSWORD from .env
async function getToken() {
  // A ready-made token wins
  if (process.env.EVAL_TOKEN) {
    // Use it as is
    return process.env.EVAL_TOKEN;
  // End of the token branch
  }
  // Read the test account from the environment
  const { EVAL_EMAIL, EVAL_PASSWORD } = process.env;
  // Both are needed to log in
  if (!EVAL_EMAIL || !EVAL_PASSWORD) {
    // Explain what to add, without printing any secret
    console.error('Set EVAL_EMAIL and EVAL_PASSWORD (a Supabase test account) in .env, or set EVAL_TOKEN.');
    // Stop with a failure code
    process.exit(1);
  // End of the missing-credentials branch
  }
  // Log in through your own API, exactly like a real client
  const res = await fetch(`${BASE_URL}/auth/login`, {
    // POST with a JSON body
    method: 'POST',
    // Tell the server the body is JSON
    headers: { 'Content-Type': 'application/json' },
    // The test account's credentials
    body: JSON.stringify({ email: EVAL_EMAIL, password: EVAL_PASSWORD }),
  // End of the login request
  });
  // Read the answer, tolerating a body that is not JSON
  const body = await res.json().catch(() => null);
  // A failed login means the eval cannot run
  if (!res.ok || !body?.access_token) {
    // Show the status and the server's message, never the password
    console.error(`Login failed (HTTP ${res.status}): ${body?.error ?? 'no error message'}`);
    // Stop with a failure code
    process.exit(1);
  // End of the failed-login branch
  }
  // Hand back the access token
  return body.access_token;
// End of getToken
}

// Send one case to /triage and return a scored result record
async function runCase(testCase, token) {
  // Remember when this case started, to time it
  const startedAt = Date.now();
  // Hold the HTTP response and body here
  let status = null;
  // The parsed JSON body
  let body = null;
  // Any network-level error message
  let networkError = null;
  // Guard the request so one failure does not stop the whole run
  try {
    // Send the message to the endpoint
    const res = await fetch(`${BASE_URL}/triage`, {
      // POST with a JSON body
      method: 'POST',
      // The login token and the JSON content type
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      // The case text, the only field the endpoint accepts
      body: JSON.stringify({ text: testCase.text }),
      // Do not wait forever
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    // End of the request options
    });
    // Remember the HTTP status
    status = res.status;
    // Read the body, tolerating text that is not JSON
    body = await res.json().catch(() => null);
  // End of the try block
  } catch (err) {
    // Remember what went wrong
    networkError = err.message;
  // End of the catch block
  }
  // The categories that count as correct: the expected one plus any extras allowed for ambiguous cases
  const accepted = [testCase.expected, ...(testCase.also_accept ?? [])];
  // The category the model gave, if the call produced a valid answer
  const got = status === 200 ? body?.category ?? null : null;
  // Build the scored record
  return {
    // Which case this is
    id: testCase.id,
    // typical, ambiguous, unsure or hostile
    kind: testCase.kind,
    // The category we believe is right
    expected: testCase.expected,
    // All categories that count as correct
    accepted,
    // The HTTP status the endpoint returned
    status,
    // The category the model gave
    got,
    // The urgency the model gave
    urgency: status === 200 ? body?.urgency ?? null : null,
    // The confidence the model gave
    confidence: status === 200 ? body?.confidence ?? null : null,
    // The reason the model gave
    reason: status === 200 ? body?.reason ?? null : null,
    // True when the category is one of the accepted ones
    categoryOk: got !== null && accepted.includes(got),
    // True when the urgency matches our label (a secondary, softer measure)
    urgencyOk: status === 200 && body?.urgency === testCase.expected_urgency,
    // For "unsure" cases only: true when the confidence stayed below 0.5, as the prompt's rule demands
    lowConfidenceOk: testCase.expect_low_confidence ? status === 200 && typeof body?.confidence === 'number' && body.confidence < LOW_CONFIDENCE : null,
    // How long the call took in milliseconds
    durationMs: Date.now() - startedAt,
    // What went wrong, if anything
    error: networkError || (status !== 200 ? `HTTP ${status} ${body?.error ?? ''}`.trim() : null),
  // End of the record
  };
// End of runCase
}

// The main flow runs inside an async function so await can be used
async function main() {
  // Load the cases
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'evals', 'cases.json'), 'utf8'));
  // Log in once
  const token = await getToken();
  // Collect the results here
  const results = [];
  // Remember when the previous request started, for pacing
  let lastStart = 0;
  // Print what we are about to do
  console.log(`Running ${cases.length} cases against ${BASE_URL}/triage (prompt ${PROMPT_VERSION}, one every ${MIN_INTERVAL_MS} ms)\n`);
  // Go through the cases one at a time
  for (const testCase of cases) {
    // Wait if the last request started too recently, to stay under the rate limit
    const wait = lastStart + MIN_INTERVAL_MS - Date.now();
    // Only sleep when a wait is actually needed
    if (wait > 0) {
      // Pause
      await sleep(wait);
    // End of the pacing branch
    }
    // Record the start time of this request
    lastStart = Date.now();
    // Run and score the case
    const result = await runCase(testCase, token);
    // Stop at once if the server is returning the stub or kill-switch answer: those scores would mean nothing
    if (/Stub response|AI triage is switched off/.test(result.reason ?? '')) {
      // Explain how to fix it
      console.error('The server is in stub mode or has the kill switch on, so no real model answered. Set LLM_STUB=0 and LLM_ENABLED=true in .env, restart the server, and run again.');
      // Stop with a failure code
      process.exit(1);
    // End of the stub-detection branch
    }
    // Keep the result
    results.push(result);
    // Show a one-line summary with a tick or a cross
    console.log(`${result.categoryOk ? 'PASS' : 'FAIL'}  ${result.id.padEnd(24)} expected ${result.accepted.join('|').padEnd(14)} got ${String(result.got ?? result.error).padEnd(10)} confidence ${result.confidence ?? '-'}  ${result.durationMs} ms`);
  // End of the cases loop
  }
  // Count the correct categories
  const correct = results.filter((r) => r.categoryOk).length;
  // Turn it into a whole-number percentage
  const percent = Math.round((correct / results.length) * 100);
  // Count the matching urgencies
  const urgencyCorrect = results.filter((r) => r.urgencyOk).length;
  // The cases that have a when-unsure expectation
  const unsureCases = results.filter((r) => r.lowConfidenceOk !== null);
  // How many of those stayed below 0.5 confidence
  const unsureCorrect = unsureCases.filter((r) => r.lowConfidenceOk).length;
  // Today's date for the README
  const date = new Date().toISOString().slice(0, 10);
  // Print the summary
  console.log(`\nCategory: ${correct}/${results.length} correct (${percent}%)`);
  // Print the secondary urgency measure
  console.log(`Urgency (softer measure): ${urgencyCorrect}/${results.length} matched`);
  // Print the when-unsure measure if there are such cases
  if (unsureCases.length > 0) {
    // Show it
    console.log(`When-unsure rule (confidence below ${LOW_CONFIDENCE}): ${unsureCorrect}/${unsureCases.length}`);
  // End of the unsure branch
  }
  // List the misses so they can be examined
  const misses = results.filter((r) => !r.categoryOk);
  // Only print the list when there are misses
  if (misses.length > 0) {
    // Heading
    console.log('\nMisses:');
    // One line per miss with the model's reason
    misses.forEach((r) => console.log(`  - ${r.id}: expected ${r.accepted.join('|')}, got ${r.got ?? r.error}${r.reason ? ` ("${r.reason}")` : ''}`));
  // End of the misses branch
  }
  // Print a line ready to paste into the README
  console.log(`\nFor the README: ${correct} of ${results.length} correct on category (${percent}%), run on ${date} with prompt ${PROMPT_VERSION} and model ${process.env.LLM_MODEL ?? 'unknown'}.`);
  // Save the full results next to the cases so they can be committed as evidence
  fs.writeFileSync(
    // The output file
    path.join(__dirname, '..', 'evals', 'last-run.json'),
    // The date, prompt, model, scores and every result, nicely indented
    JSON.stringify({ date, promptVersion: PROMPT_VERSION, model: process.env.LLM_MODEL ?? null, categoryCorrect: correct, total: results.length, percent, urgencyCorrect, results }, null, 2),
  // End of the write call
  );
  // Tell the user where the file is
  console.log('Full results saved to evals/last-run.json');
// End of main
}

// Run and report any unexpected crash
main().catch((err) => {
  // Show the crash
  console.error('Eval crashed:', err.message);
  // Stop with a failure code
  process.exit(1);
// End of the error handler
});
