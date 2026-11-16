// Local development server. Vercel does not use this file.
// Loads backend/.env (if present) and starts the API on PORT.

try {
  process.loadEnvFile(`${__dirname}/.env`);
} catch {
  // No .env file: rely on variables already set in the shell.
}

const app = require('./src/app');

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`API running on http://localhost:${port}`);
});
