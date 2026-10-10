// Load variables from .env into process.env
require('dotenv').config();
// Import Express, the web framework
const express = require('express');
// Create the app
const app = express();
// Use the PORT from .env, or 3000 if none is set
const PORT = process.env.PORT || 3000;
// Define GET /health, the Stage 0 endpoint
app.get('/health', (req, res) => {
  // Reply with HTTP 200 and the JSON the checkpoint expects
  res.status(200).json({ status: 'ok' });
// End of the health handler
});
// Start listening for requests
app.listen(PORT, () => {
  // Print a short confirmation
  console.log(`Hello server listening on port ${PORT}`);
// End of the listen callback
});