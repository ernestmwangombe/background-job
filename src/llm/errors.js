// Import the helpers that recognise timeouts and read statuses
const { isTimeout } = require('./retry');

// Turn any model-call error into a short outcome name for the logs plus the HTTP answer for the caller
function describeError(err) {
  // A missing provider setting is a server configuration problem
  if (err?.code === 'LLM_NOT_CONFIGURED') {
    // 503: the feature is unavailable
    return { outcome: 'not_configured', httpStatus: 503, error: 'Service Unavailable', message: 'The model is not configured on the server.' };
  // End of the not-configured branch
  }
  // The model took longer than the client timeout (after any retries)
  if (isTimeout(err)) {
    // 504: something we depend on took too long
    return { outcome: 'timeout', httpStatus: 504, error: 'Gateway Timeout', message: 'The model took too long to respond. Please try again.' };
  // End of the timeout branch
  }
  // Read the HTTP status the provider sent, if any
  const status = typeof err?.status === 'number' ? err.status : undefined;
  // Rate limited, and still limited after the retries
  if (status === 429) {
    // 503: temporarily unavailable
    return { outcome: 'rate_limited', httpStatus: 503, error: 'Service Unavailable', message: 'The model provider is rate limiting requests. Please try again shortly.' };
  // End of the rate-limit branch
  }
  // The provider rejected our credentials: a configuration problem that retrying cannot fix
  if (status === 401 || status === 403) {
    // 502: the upstream call failed, with a clear reason
    return { outcome: 'auth_error', httpStatus: 502, error: 'Bad Gateway', message: 'The model call failed because the server could not authenticate with the model provider.' };
  // End of the auth branch
  }
  // The provider had a server error, and it persisted after the retries
  if (status !== undefined && status >= 500) {
    // 502: the upstream call failed
    return { outcome: 'provider_error', httpStatus: 502, error: 'Bad Gateway', message: 'The model provider had an error. Please try again.' };
  // End of the provider-error branch
  }
  // Anything else, such as a 400 or a network failure
  return { outcome: status === 400 ? 'bad_request' : 'error', httpStatus: 502, error: 'Bad Gateway', message: 'The model call failed.' };
// End of describeError
}

// Export the function for the route and the self-test
module.exports = { describeError };
