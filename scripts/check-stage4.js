// Offline self-test for Stage 4: it never calls the model, never waits for real timers, and never uses quota
// Import the retry helpers under test
const { withRetry, retryDelayMs, parseRetryAfter, BASE_DELAY_MS, JITTER_MS, MAX_DELAY_MS } = require('../src/llm/retry');
// Import the error-to-answer mapping under test
const { describeError } = require('../src/llm/errors');
// Import the kill-switch check under test
const { isLlmEnabled } = require('../src/llm/killSwitch');
// Import the schema pieces to prove the fallback satisfies the contract
const { triageOutputSchema, FALLBACK_RESPONSE } = require('../src/llm/schema');
// Import the repair loop and meter to prove the meter is shared across both calls
const { classifyMessage, createMeter, buildRequest } = require('../src/llm/triageModel');

// Count how many checks passed and failed
let passed = 0;
// Count failures separately so the script can exit with an error code
let failed = 0;

// Record one check: print PASS or FAIL with a name
function check(name, condition) {
  // A true condition is a pass
  if (condition) {
    // Count it
    passed += 1;
    // Show it
    console.log(`PASS  ${name}`);
  // End of the pass branch
  } else {
    // Count it
    failed += 1;
    // Show it
    console.log(`FAIL  ${name}`);
  // End of the fail branch
  }
// End of check
}

// Build an error that looks like the OpenAI client's HTTP errors
function httpError(status, headers) {
  // A normal error with a message
  const err = new Error(`${status} error`);
  // The HTTP status
  err.status = status;
  // Optional response headers
  err.headers = headers;
  // Hand it back
  return err;
// End of httpError
}

// Build a timeout error with the same class name the OpenAI client uses
function timeoutError() {
  // Define a class with the real class name
  class APIConnectionTimeoutError extends Error {}
  // Return an instance with the real message
  return new APIConnectionTimeoutError('Request timed out.');
// End of timeoutError
}

// Build a function that fails with the given errors in order and then succeeds, recording how many times it was called
function flaky(errors, finalValue = 'ok') {
  // Track the calls
  const state = { calls: 0 };
  // The function that stands in for one model request
  state.fn = async () => {
    // Count this call
    state.calls += 1;
    // Fail while there are errors left to throw
    if (state.calls <= errors.length) {
      // Throw the next prepared error
      throw errors[state.calls - 1];
    // End of the failing branch
    }
    // Otherwise succeed
    return finalValue;
  // End of the fake request
  };
  // Hand back the state and the function
  return state;
// End of flaky
}

// Run withRetry with a fake sleep that records waits instead of waiting
async function run(fn, options = {}) {
  // Record the waits here
  const sleeps = [];
  // Record the retry reports here
  const retries = [];
  // Hold the outcome
  let outcome;
  // Guard the call so thrown errors can be inspected
  try {
    // Run with a recording sleep and the given options
    outcome = { value: await withRetry(fn, { sleep: async (ms) => { sleeps.push(ms); }, onRetry: (info) => retries.push(info), ...options }) };
  // End of the try block
  } catch (err) {
    // Keep the thrown error
    outcome = { error: err };
  // End of the catch block
  }
  // Return everything the checks need
  return { ...outcome, sleeps, retries };
// End of run
}

// The checks run inside an async function so await can be used
async function main() {
  // --- which failures are retried ---
  // A 429 followed by success should be retried once and then succeed
  const t429 = flaky([httpError(429)]);
  // Run it
  const r429 = await run(t429.fn);
  // Two calls, one wait, success
  check('429 is retried and then succeeds', r429.value === 'ok' && t429.calls === 2 && r429.sleeps.length === 1);
  // The first wait is about one second plus jitter
  check('first backoff is 1s plus jitter', r429.sleeps[0] >= BASE_DELAY_MS && r429.sleeps[0] < BASE_DELAY_MS + JITTER_MS);

  // A server error that never recovers is retried the allowed number of times and then thrown
  const t500 = flaky([httpError(500), httpError(500), httpError(500), httpError(500), httpError(500)]);
  // Run it with the default of three retries
  const r500 = await run(t500.fn);
  // Four calls in total (one try plus three retries) and the original error thrown
  check('5xx is retried 3 times then given up (4 calls)', t500.calls === 4 && r500.error?.status === 500);
  // The waits follow 1s, 2s, 4s plus jitter
  check('backoff doubles: 1s, 2s, 4s plus jitter', r500.sleeps.length === 3 && [1000, 2000, 4000].every((base, i) => r500.sleeps[i] >= base && r500.sleeps[i] < base + JITTER_MS));
  // Each retry is reported to the logger
  check('each retry is reported', r500.retries.length === 3 && r500.retries[0].retry === 1 && r500.retries[2].retry === 3);

  // A timeout is retried like a 5xx
  const tTimeout = flaky([timeoutError()]);
  // Run it
  const rTimeout = await run(tTimeout.fn);
  // Two calls and success
  check('timeout is retried', rTimeout.value === 'ok' && tTimeout.calls === 2);

  // 400, 401 and 403 are never retried
  for (const status of [400, 401, 403]) {
    // A function that would fail every time with this status
    const t = flaky([httpError(status), httpError(status), httpError(status), httpError(status)]);
    // Run it
    const r = await run(t.fn);
    // Exactly one call and no waits
    check(`${status} is never retried (1 call, no waiting)`, t.calls === 1 && r.sleeps.length === 0 && r.error?.status === status);
  // End of the loop
  }
  // A plain network failure with no status is not retried either
  const tNet = flaky([Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })]);
  // Run it
  const rNet = await run(tNet.fn);
  // One call
  check('error without a status is not retried', tNet.calls === 1 && rNet.error !== undefined);
  // The missing-configuration error is not retried
  const tCfg = flaky([Object.assign(new Error('missing settings'), { code: 'LLM_NOT_CONFIGURED' })]);
  // Run it
  const rCfg = await run(tCfg.fn);
  // One call
  check('missing configuration is not retried', tCfg.calls === 1 && rCfg.error !== undefined);
  // Zero allowed retries means a single attempt
  const tZero = flaky([httpError(500), httpError(500)]);
  // Run it with no retries allowed
  const rZero = await run(tZero.fn, { maxRetries: 0 });
  // One call
  check('maxRetries 0 means a single attempt', tZero.calls === 1 && rZero.error?.status === 500);

  // --- Retry-After and jitter ---
  // A numeric Retry-After of 2 seconds is obeyed exactly
  const tRA = flaky([httpError(429, { 'retry-after': '2' })]);
  // Run it
  const rRA = await run(tRA.fn);
  // The wait is exactly 2000 ms, with no jitter or backoff guess
  check('Retry-After in seconds is obeyed exactly', rRA.sleeps[0] === 2000);
  // A fetch-style Headers object with a get method works too
  const headersLike = { get: (name) => (name === 'retry-after' ? '3' : null) };
  // Run it
  const tRA2 = flaky([httpError(429, headersLike)]);
  // Get the result
  const rRA2 = await run(tRA2.fn);
  // The wait is exactly 3000 ms
  check('Retry-After works with fetch-style Headers', rRA2.sleeps[0] === 3000);
  // An HTTP-date Retry-After is converted to a wait from now
  const now = Date.parse('2026-10-12T10:00:00Z');
  // Three seconds in the future, written as an HTTP date
  const dateValue = new Date(now + 3000).toUTCString();
  // Parse it with the fixed "now"
  check('Retry-After as an HTTP date is understood', parseRetryAfter(dateValue, now) === 3000);
  // A date in the past never produces a negative wait
  check('Retry-After in the past becomes zero', parseRetryAfter(new Date(now - 5000).toUTCString(), now) === 0);
  // A nonsense value is ignored
  check('unreadable Retry-After is ignored', parseRetryAfter('soon') === null);
  // A Retry-After longer than the cap means we give up instead of holding the request open
  const tLong = flaky([httpError(429, { 'retry-after': String(MAX_DELAY_MS / 1000 + 50) })]);
  // Run it
  const rLong = await run(tLong.fn);
  // One call, no waiting, error passed on
  check('Retry-After beyond the cap is not waited for', tLong.calls === 1 && rLong.sleeps.length === 0 && rLong.error?.status === 429);
  // Jitter stays within its bounds: no random gives exactly the base, a maximal random stays just under base plus jitter
  check('jitter bounds are respected', retryDelayMs(0, httpError(500), () => 0) === 1000 && retryDelayMs(0, httpError(500), () => 0.999) === 1000 + Math.floor(0.999 * JITTER_MS));

  // --- what callers and logs see for each failure ---
  // A timeout becomes 504
  check('timeout maps to 504', describeError(timeoutError()).httpStatus === 504 && describeError(timeoutError()).outcome === 'timeout');
  // A 429 becomes 503
  check('429 maps to 503 rate_limited', describeError(httpError(429)).httpStatus === 503 && describeError(httpError(429)).outcome === 'rate_limited');
  // A 401 and a 403 become 502 with a clear auth outcome
  check('401 and 403 map to 502 auth_error', describeError(httpError(401)).outcome === 'auth_error' && describeError(httpError(403)).httpStatus === 502);
  // A 500 becomes 502
  check('5xx maps to 502 provider_error', describeError(httpError(503)).httpStatus === 502 && describeError(httpError(503)).outcome === 'provider_error');
  // A 400 becomes 502 bad_request
  check('400 maps to 502 bad_request', describeError(httpError(400)).outcome === 'bad_request');
  // Missing configuration becomes 503
  check('missing configuration maps to 503', describeError(Object.assign(new Error('x'), { code: 'LLM_NOT_CONFIGURED' })).httpStatus === 503);
  // No caller message ever contains the provider's raw error text
  check('caller messages never echo provider error text', !describeError(httpError(500)).message.includes('500 error'));

  // --- the kill switch ---
  // Remember the original setting so the test can restore it
  const original = process.env.LLM_ENABLED;
  // Unset means enabled
  delete process.env.LLM_ENABLED;
  // Check it
  check('kill switch: unset means enabled', isLlmEnabled() === true);
  // The word true means enabled
  process.env.LLM_ENABLED = 'true';
  // Check it
  check('kill switch: "true" means enabled', isLlmEnabled() === true);
  // The word false means disabled, ignoring case and spaces
  process.env.LLM_ENABLED = ' FALSE ';
  // Check it
  check('kill switch: "false" means disabled (case and spaces ignored)', isLlmEnabled() === false);
  // Zero also means disabled
  process.env.LLM_ENABLED = '0';
  // Check it
  check('kill switch: "0" means disabled', isLlmEnabled() === false);
  // Restore the original setting
  if (original === undefined) { delete process.env.LLM_ENABLED; } else { process.env.LLM_ENABLED = original; }
  // The fallback answer must satisfy the output schema and be deterministic
  const fallbackCheck = triageOutputSchema.safeParse(FALLBACK_RESPONSE);
  // Check both properties
  check('fallback answer satisfies the output schema', fallbackCheck.success && FALLBACK_RESPONSE.category === 'other' && FALLBACK_RESPONSE.confidence === 0);

  // --- the cost meter ---
  // A fake model that records the meter it receives on each call
  const seenMeters = [];
  // Two replies: an invalid one, then a valid one, so both calls happen
  const replies = ['not json', '{"category":"bug","urgency":"high","confidence":0.9,"reason":"Crash."}'];
  // The fake call
  const call = async (messages, meter) => { seenMeters.push(meter); return replies[seenMeters.length - 1]; };
  // Create a meter and run the repair loop with it
  const meter = createMeter();
  // Run it
  const result = await classifyMessage('crash', { call, meter });
  // The same meter object must reach both calls, so tokens and retries add up across the repair
  check('one meter is shared by the first call and the repair call', result.ok && result.repaired && seenMeters.length === 2 && seenMeters[0] === meter && seenMeters[1] === meter);

  // --- the optional reasoning effort ---
  // Remember the original setting so the test can restore it
  const originalEffort = process.env.LLM_REASONING_EFFORT;
  // With nothing set, the field must not be sent at all
  delete process.env.LLM_REASONING_EFFORT;
  // Build a request
  const plain = buildRequest([{ role: 'user', content: 'x' }]);
  // The field must be absent and the low temperature present
  check('reasoning_effort is not sent unless set', !('reasoning_effort' in plain) && plain.temperature === 0.2);
  // With a value set, it must be passed through
  process.env.LLM_REASONING_EFFORT = ' minimal ';
  // Build another request
  const tuned = buildRequest([{ role: 'user', content: 'x' }]);
  // The trimmed value must be present
  check('reasoning_effort is sent when set', tuned.reasoning_effort === 'minimal');
  // Restore the original setting
  if (originalEffort === undefined) { delete process.env.LLM_REASONING_EFFORT; } else { process.env.LLM_REASONING_EFFORT = originalEffort; }

  // Print the summary
  console.log(`\n${passed} passed, ${failed} failed`);
  // Exit with an error code if anything failed, so scripts can detect it
  process.exitCode = failed === 0 ? 0 : 1;
// End of main
}

// Run the checks and report any unexpected crash
main().catch((err) => {
  // Show the crash
  console.error('Self-test crashed:', err);
  // Exit with an error code
  process.exitCode = 1;
// End of the error handler
});
