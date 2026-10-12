// The first wait before a retry, in milliseconds; waits then double: 1s, 2s, 4s
const BASE_DELAY_MS = 1000;
// The most random extra time added to each wait, so many clients do not all retry at the same instant
const JITTER_MS = 250;
// The longest wait we will accept; if a server asks for more, we give up instead of holding the caller's request open
const MAX_DELAY_MS = 10000;

// Decide whether an error means "the request timed out"
function isTimeout(err) {
  // The OpenAI client names its timeout error class APIConnectionTimeoutError
  if (err?.constructor?.name === 'APIConnectionTimeoutError') {
    // That is a timeout
    return true;
  // End of the class-name check
  }
  // Other libraries use these names or codes, or put "timed out" in the message
  return err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.code === 'ETIMEDOUT' || /timed? ?out/i.test(String(err?.message ?? ''));
// End of isTimeout
}

// Read the HTTP status number from an error, if it has one
function getStatus(err) {
  // Only trust a real number
  return typeof err?.status === 'number' ? err.status : undefined;
// End of getStatus
}

// Decide whether a failure is worth retrying: timeouts, 429 and 5xx yes; 400, 401, 403 and everything else no
function isRetryable(err) {
  // A timeout is retryable
  if (isTimeout(err)) {
    // Yes
    return true;
  // End of the timeout branch
  }
  // Look at the HTTP status
  const status = getStatus(err);
  // 429 (rate limited) and any 5xx (server trouble) are retryable
  return status === 429 || (status !== undefined && status >= 500 && status <= 599);
// End of isRetryable
}

// Read one header from either a plain object or a fetch-style Headers object
function readHeader(headers, name) {
  // No headers means no value
  if (!headers) {
    // Nothing to read
    return undefined;
  // End of the no-headers branch
  }
  // Fetch-style Headers have a get method
  if (typeof headers.get === 'function') {
    // Use it and turn null into undefined
    return headers.get(name) ?? undefined;
  // End of the Headers branch
  }
  // Plain objects use the lower-case name
  return headers[name.toLowerCase()] ?? headers[name];
// End of readHeader
}

// Turn a Retry-After header into milliseconds; it is either a number of seconds or an HTTP date
function parseRetryAfter(value, now = Date.now()) {
  // No header means no advice
  if (value === undefined || value === null || value === '') {
    // Signal "no advice"
    return null;
  // End of the no-header branch
  }
  // First try the "seconds" form
  const seconds = Number(value);
  // A real number means seconds
  if (Number.isFinite(seconds)) {
    // Convert to milliseconds, never negative
    return Math.max(0, seconds * 1000);
  // End of the seconds branch
  }
  // Otherwise try the HTTP date form
  const date = Date.parse(value);
  // A real date means "wait until then"
  if (!Number.isNaN(date)) {
    // Convert to milliseconds from now, never negative
    return Math.max(0, date - now);
  // End of the date branch
  }
  // Unreadable header: no advice
  return null;
// End of parseRetryAfter
}

// Work out how long to wait before retry number "attempt" (0 for the first retry)
function retryDelayMs(attempt, err, random = Math.random, now = Date.now()) {
  // If the server said how long to wait, obey it exactly instead of guessing
  const advised = parseRetryAfter(readHeader(err?.headers, 'retry-after'), now);
  // Use the server's advice when there is any
  if (advised !== null) {
    // Obey it
    return advised;
  // End of the Retry-After branch
  }
  // Otherwise use exponential backoff (1s, 2s, 4s, ...) plus a small random amount
  return BASE_DELAY_MS * 2 ** attempt + Math.floor(random() * JITTER_MS);
// End of retryDelayMs
}

// The default way to wait: a real timer
function defaultSleep(ms) {
  // Resolve after the given number of milliseconds
  return new Promise((resolve) => setTimeout(resolve, ms));
// End of defaultSleep
}

// Run fn, retrying only the right failures; "sleep" and "random" can be swapped in tests, "onRetry" is told about each retry
async function withRetry(fn, { maxRetries = 3, sleep = defaultSleep, random = Math.random, onRetry } = {}) {
  // Count the attempts, starting with the first call as attempt 0
  for (let attempt = 0; ; attempt += 1) {
    // Guard the call so a failure can be inspected
    try {
      // Return the result as soon as a call succeeds
      return await fn();
    // End of the try block
    } catch (err) {
      // Give up at once for errors that retrying cannot fix (400, 401, 403, config problems), or when retries are used up
      if (!isRetryable(err) || attempt >= maxRetries) {
        // Pass the error on unchanged
        throw err;
      // End of the give-up branch
      }
      // Work out how long to wait
      const delayMs = retryDelayMs(attempt, err, random);
      // If the wait is too long to hold a caller's request open, give up instead
      if (delayMs > MAX_DELAY_MS) {
        // Pass the error on unchanged
        throw err;
      // End of the too-long branch
      }
      // Tell the caller code that a retry is about to happen, so it can be counted and logged
      if (onRetry) {
        // Report which retry this is, how long we will wait, and why
        onRetry({ retry: attempt + 1, delayMs, status: getStatus(err) ?? null, reason: isTimeout(err) ? 'timeout' : 'http_status' });
      // End of the onRetry branch
      }
      // Wait, then loop around for the next attempt
      await sleep(delayMs);
    // End of the catch block
    }
  // End of the attempts loop
  }
// End of withRetry
}

// Export everything the model call and the self-test need
module.exports = { withRetry, isRetryable, isTimeout, retryDelayMs, parseRetryAfter, BASE_DELAY_MS, JITTER_MS, MAX_DELAY_MS };
