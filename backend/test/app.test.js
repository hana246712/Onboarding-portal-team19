// Basic API tests that need no database.
// Run with: npm test

const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

process.env.CORS_ORIGINS = 'https://frontend.example.com';
const app = require('../src/app');

test('GET /api/health returns ok', async () => {
  const res = await request(app).get('/api/health');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { status: 'ok' });
});

test('unknown API route returns 404 JSON', async () => {
  const res = await request(app).get('/api/does-not-exist');
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, 'Not found');
});

test('malformed JSON returns 400 without internal details', async () => {
  const res = await request(app)
    .post('/api/anything')
    .set('Content-Type', 'application/json')
    .send('{"broken":');
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'Invalid JSON body');
  assert.ok(!JSON.stringify(res.body).includes('SyntaxError'));
});

test('CORS allows the configured frontend origin', async () => {
  const res = await request(app)
    .get('/api/health')
    .set('Origin', 'https://frontend.example.com');
  assert.strictEqual(res.headers['access-control-allow-origin'], 'https://frontend.example.com');
});

test('CORS does not allow other origins', async () => {
  const res = await request(app)
    .get('/api/health')
    .set('Origin', 'https://evil.example.com');
  assert.strictEqual(res.headers['access-control-allow-origin'], undefined);
});

test('X-Powered-By header is not sent', async () => {
  const res = await request(app).get('/api/health');
  assert.strictEqual(res.headers['x-powered-by'], undefined);
});
