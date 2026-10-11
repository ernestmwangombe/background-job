// Import Node's file-system module so failed answers can be written to disk
const fs = require('fs');
// Import Node's path module so the log location works on Windows and Linux
const path = require('path');

// Work out where the quarantine log lives; the default is logs/quarantine.jsonl in the project root
function quarantineFile() {
  // Allow an override through the environment (the self-test uses this so it never touches the real log)
  return process.env.QUARANTINE_FILE || path.join(__dirname, '..', '..', 'logs', 'quarantine.jsonl');
// End of quarantineFile
}

// Append one failed answer to the quarantine log; never throws, because a logging problem must not crash the API
function quarantine(entry) {
  // Guard every file operation
  try {
    // Find the log file
    const file = quarantineFile();
    // Create the logs folder if it does not exist yet
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Add a timestamp and write the entry as one JSON line (the .jsonl format)
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
    // Tell the caller the write worked
    return true;
  // End of the try block
  } catch (err) {
    // Report the problem on the server console only
    console.error('[triage] could not write quarantine log:', err.message);
    // Tell the caller the write failed
    return false;
  // End of the catch block
  }
// End of quarantine
}

// Export the function for the route and the self-test
module.exports = { quarantine };
