// Import Node's file-system module so the prompt can be read from its file
const fs = require('fs');
// Import Node's path module so the file location works on Windows and Linux
const path = require('path');

// The prompt's version name; it matches the file name, so changing the prompt means a new file such as triage-v2
const PROMPT_VERSION = 'triage-v1';
// The full path to the prompt file, two folders up from src/llm and then into prompts/
const PROMPT_PATH = path.join(__dirname, '..', '..', 'prompts', `${PROMPT_VERSION}.md`);

// Read the prompt once at startup, so a missing file fails fast instead of on the first request
const SYSTEM_PROMPT = fs
  // Read the whole file as text
  .readFileSync(PROMPT_PATH, 'utf8')
  // Normalise Windows line endings so the model always sees the same text
  .replace(/\r\n/g, '\n')
  // Remove blank space at both ends
  .trim();

// Export the prompt text and its version for the model call and, later, the logs
module.exports = { PROMPT_VERSION, SYSTEM_PROMPT };
