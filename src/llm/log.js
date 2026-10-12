// Write one structured log line to standard output; the environment decides where logs go (Twelve-Factor style)
function logEvent(event, fields = {}) {
  // One JSON object per line is easy to search, count and total up later
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
// End of logEvent
}

// Export the function for the route, the retry loop and the model call
module.exports = { logEvent };
