// Offline self-test for Stage 3: it never calls the model, never uses quota, and never touches your real quarantine log
// Import Node's file-system module to read back the temporary log
const fs = require('fs');
// Import Node's os module to find a temporary folder
const os = require('os');
// Import Node's path module to build the temporary log path
const path = require('path');

// Point the quarantine log at a temporary file so the real logs/ folder is untouched
process.env.QUARANTINE_FILE = path.join(os.tmpdir(), `quarantine-test-${process.pid}.jsonl`);

// Import the parser and validator under test
const { parseAndValidate } = require('../src/llm/parseOutput');
// Import the repair loop under test
const { classifyMessage } = require('../src/llm/triageModel');
// Import the quarantine writer under test
const { quarantine } = require('../src/llm/quarantine');

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

// A valid answer used by several checks
const GOOD = '{"category":"billing","urgency":"high","confidence":0.9,"reason":"Duplicate charge."}';

// Build a fake model that returns the given replies in order and records every call
function fakeModel(replies) {
  // Remember each list of messages it receives
  const calls = [];
  // The function that stands in for the real model call
  const call = async (messages) => {
    // Record the messages
    calls.push(messages);
    // Return the next prepared reply, or the last one if we run out
    return replies[Math.min(calls.length - 1, replies.length - 1)];
  // End of the fake call
  };
  // Return both the function and its call log
  return { call, calls };
// End of fakeModel
}

// The checks run inside an async function so await can be used
async function main() {
  // --- parsing and validation ---
  // A clean JSON reply should pass
  check('clean JSON is accepted', parseAndValidate(GOOD).ok === true);
  // A reply wrapped in a markdown fence should pass
  check('code-fenced JSON is accepted', parseAndValidate('```json\n' + GOOD + '\n```').ok === true);
  // A reply with chatty text around the object should pass
  check('chatty text around JSON is accepted', parseAndValidate("Sure! Here's the JSON: " + GOOD + ' Hope that helps.').ok === true);
  // A category outside the closed list must fail
  const badCategory = parseAndValidate(GOOD.replace('billing', 'payments'));
  // It should fail and the error should name the field
  check('category outside the list is rejected and named', badCategory.ok === false && badCategory.error.includes('category'));
  // An extra field must fail because the schema is strict
  check('extra field is rejected', parseAndValidate(GOOD.replace('}', ',"extra":1}')).ok === false);
  // A confidence above 1 must fail
  check('confidence above 1 is rejected', parseAndValidate(GOOD.replace('0.9', '1.5')).ok === false);
  // Plain prose with no object must fail
  check('reply with no JSON is rejected', parseAndValidate('Sorry, I cannot help with that.').ok === false);
  // Broken JSON syntax must fail without throwing
  check('broken JSON is rejected without throwing', parseAndValidate('{"category": "billing",').ok === false);
  // An empty reply must fail
  check('empty reply is rejected', parseAndValidate('').ok === false);

  // --- the repair loop ---
  // A valid first answer needs exactly one call
  const happy = fakeModel([GOOD]);
  // Run it
  const happyResult = await classifyMessage('I was charged twice', { call: happy.call });
  // One call, ok, no repair
  check('valid first answer: one call, no repair', happyResult.ok && !happyResult.repaired && happy.calls.length === 1);

  // A bad first answer followed by a good one should be repaired with exactly two calls
  const repairable = fakeModel([GOOD.replace('billing', 'payments'), GOOD]);
  // Run it
  const repairResult = await classifyMessage('zebra-7731 unique customer text', { call: repairable.call });
  // Two calls, ok, repaired
  check('bad then good: repaired with exactly two calls', repairResult.ok && repairResult.repaired && repairable.calls.length === 2);
  // Look at the messages sent for the repair
  const repairMessages = repairable.calls[1];
  // The roles must be system, user, assistant, user
  check('repair call keeps the prompt and adds the broken answer and the error', repairMessages.map((m) => m.role).join(',') === 'system,user,assistant,user');
  // The last message must contain the exact error and the instruction
  check('repair message quotes the validation error', repairMessages[3].content.includes('category') && repairMessages[3].content.includes('Return only corrected JSON'));
  // The customer's text must appear only in the user message, never in the system prompt
  check('customer text is only in the user message, never the system prompt', !repairMessages[0].content.includes('zebra-7731') && repairMessages[1].content.includes('zebra-7731'));

  // Two bad answers should stop after exactly two calls and report failure
  const hopeless = fakeModel(['not json at all', GOOD.replace('billing', 'payments')]);
  // Run it
  const failResult = await classifyMessage('anything', { call: hopeless.call });
  // Two calls, not ok
  check('two bad answers: gives up after exactly two calls', failResult.ok === false && hopeless.calls.length === 2);
  // The failure must carry both raw outputs for the quarantine log
  check('failure carries both raw outputs and the prompt version', failResult.rawOutputs.length === 2 && failResult.promptVersion === 'triage-v1');
  // The failure result must never carry a "data" field a route could return by mistake
  check('failure has no data field', failResult.data === undefined);

  // --- the quarantine log ---
  // Write one entry
  const written = quarantine({ input: 'anything', error: 'category: bad', promptVersion: 'triage-v1', rawOutputs: ['x', 'y'] });
  // Read the file back
  const line = JSON.parse(fs.readFileSync(process.env.QUARANTINE_FILE, 'utf8').trim().split('\n').pop());
  // The entry must contain the input, error, prompt version and a timestamp
  check('quarantine writes a JSON line with input, error, prompt version and time', written === true && line.input === 'anything' && line.error === 'category: bad' && line.promptVersion === 'triage-v1' && typeof line.at === 'string');
  // Clean up the temporary file
  fs.unlinkSync(process.env.QUARANTINE_FILE);

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
