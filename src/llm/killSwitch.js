// The kill switch: LLM_ENABLED=false turns the model off without a deploy, only a restart with a new setting
function isLlmEnabled() {
  // Read the setting as text, treating "not set" as enabled, and ignore case and spaces
  const value = String(process.env.LLM_ENABLED ?? 'true').trim().toLowerCase();
  // These values all mean "off"
  return !['false', '0', 'off', 'no'].includes(value);
// End of isLlmEnabled
}

// Export the check for the route
module.exports = { isLlmEnabled };
