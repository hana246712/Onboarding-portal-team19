// Express app. Vercel runs it as one function; `npm run dev` runs it locally.

const express = require('express');
const cors = require('cors');

const app = express();

// Only the frontend origins listed in CORS_ORIGINS may call the API.
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Requests with no Origin header (Postman, curl, Vercel Cron) are allowed;
      // they still need a valid token or CRON_SECRET on protected routes.
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    allowedHeaders: ['Content-Type', 'Authorization'],
    // Lets the login page read how long a lockout lasts (429 + Retry-After).
    exposedHeaders: ['Retry-After'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  })
);

app.disable('x-powered-by');

// Security headers on every API response.
// The API only returns JSON, so it may not be framed, sniffed as HTML,
// cached by a browser or shared proxy, or load anything itself.
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  });
  next();
});

// Vercel sits in front of the API as a proxy. Trusting one proxy hop
// makes req.ip the real client address (used by the login-attempt limit).
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api', require('./routes/auth'));
app.use('/api', require('./routes/users'));
app.use('/api', require('./routes/templates'));
app.use('/api', require('./routes/plans'));
app.use('/api', require('./routes/dashboard'));

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Malformed JSON and unexpected errors. Never return stack traces or
// internal details to the client.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  console.error(JSON.stringify({ level: 'error', message: err.message, path: req.path }));
  return res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
