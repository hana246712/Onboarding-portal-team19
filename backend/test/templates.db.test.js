// Template endpoint tests against a real database (issue #5).
// Runs only when DATABASE_URL is set (backend/.env, DEV branch).
// Cleans up: deletes the templates it creates and deactivates its users.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

try {
  process.loadEnvFile(`${__dirname}/../.env`);
} catch {
  // no .env file
}
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256-signing';
}
const SKIP = process.env.DATABASE_URL ? false : 'DATABASE_URL not set; database tests skipped';

const request = require('supertest');

let app;
let pool;
let signToken;
const run = crypto.randomBytes(4).toString('hex');
const tokens = {};
const userEmails = [];
const templateIds = [];

const as = (role) => ({ Authorization: `Bearer ${tokens[role]}` });
const sample = (over = {}) => ({
  title: `Test template ${run}`,
  description: 'Created by automated tests',
  tasks: [
    { title: 'Kick-off call', offsetDays: 0, visibility: 'customer', actor: 'staff' },
    { title: 'Upload company documents', offsetDays: 3, visibility: 'customer', actor: 'customer' },
    { title: 'Internal credit check', offsetDays: 5, visibility: 'internal', actor: 'staff' },
  ],
  ...over,
});

async function createTemplate(body = sample()) {
  const res = await request(app).post('/api/templates').set(as('Admin')).send(body);
  if (res.status === 201) templateIds.push(res.body.id);
  return res;
}

before(async () => {
  if (SKIP) return;
  app = require('../src/app');
  pool = require('../src/db/pool');
  ({ signToken } = require('../src/lib/tokens'));
  for (const role of ['Admin', 'Staff', 'Customer']) {
    const email = `test-tpl-${role.toLowerCase()}-${run}@example.test`;
    const { rows } = await pool.db().query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, 'not-a-real-hash', $3) RETURNING id`,
      [`Test ${role}`, email, role]
    );
    userEmails.push(email);
    tokens[role] = signToken(rows[0].id);
  }
});

after(async () => {
  if (SKIP) return;
  await pool.db().query('DELETE FROM templates WHERE id = ANY($1)', [templateIds]);
  await pool.db().query('UPDATE users SET active = false WHERE email = ANY($1)', [userEmails]);
  await pool.db().end();
});

test('Admin creates a template with task rules -> 201', { skip: SKIP }, async () => {
  const res = await createTemplate();
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.status, 'active');
  assert.strictEqual(res.body.version, 1);
  assert.deepStrictEqual(
    res.body.tasks.map((t) => [t.position, t.title, t.offsetDays, t.visibility, t.actor]),
    [
      [1, 'Kick-off call', 0, 'customer', 'staff'],
      [2, 'Upload company documents', 3, 'customer', 'customer'],
      [3, 'Internal credit check', 5, 'internal', 'staff'],
    ]
  );
});

test('not logged in -> 401; Staff or Customer creating -> 403', { skip: SKIP }, async () => {
  assert.strictEqual((await request(app).post('/api/templates').send(sample())).status, 401);
  assert.strictEqual((await request(app).post('/api/templates').set(as('Staff')).send(sample())).status, 403);
  assert.strictEqual((await request(app).post('/api/templates').set(as('Customer')).send(sample())).status, 403);
});

test('invalid rules -> 400 and nothing is saved', { skip: SKIP }, async () => {
  const before = await pool.db().query('SELECT COUNT(*)::int AS n FROM templates');
  const bad = sample({ tasks: [{ title: 'x', offsetDays: 1, visibility: 'internal', actor: 'customer' }] });
  const res = await createTemplate(bad);
  assert.strictEqual(res.status, 400);
  const after = await pool.db().query('SELECT COUNT(*)::int AS n FROM templates');
  assert.strictEqual(after.rows[0].n, before.rows[0].n);
});

test('Staff can list and read templates; Customer cannot', { skip: SKIP }, async () => {
  const { body: created } = await createTemplate();
  const list = await request(app).get('/api/templates').set(as('Staff'));
  assert.strictEqual(list.status, 200);
  const mine = list.body.find((t) => t.id === created.id);
  assert.strictEqual(mine.taskCount, 3);

  const one = await request(app).get(`/api/templates/${created.id}`).set(as('Staff'));
  assert.strictEqual(one.status, 200);
  assert.strictEqual(one.body.tasks.length, 3);

  assert.strictEqual((await request(app).get('/api/templates').set(as('Customer'))).status, 403);
  assert.strictEqual((await request(app).get(`/api/templates/${created.id}`).set(as('Customer'))).status, 403);
});

test('unknown or malformed id -> 404', { skip: SKIP }, async () => {
  assert.strictEqual((await request(app).get('/api/templates/999999999').set(as('Admin'))).status, 404);
  assert.strictEqual((await request(app).get('/api/templates/abc').set(as('Admin'))).status, 404);
  assert.strictEqual((await request(app).put('/api/templates/999999999').set(as('Admin')).send(sample())).status, 404);
});

test('edit replaces the tasks and increases the version', { skip: SKIP }, async () => {
  const { body: created } = await createTemplate();
  const res = await request(app)
    .put(`/api/templates/${created.id}`)
    .set(as('Admin'))
    .send(sample({ title: `Edited ${run}`, tasks: [{ title: 'Only task', offsetDays: 1, visibility: 'customer', actor: 'customer' }] }));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.version, 2);
  assert.strictEqual(res.body.title, `Edited ${run}`);
  assert.deepStrictEqual(res.body.tasks.map((t) => t.title), ['Only task']);

  assert.strictEqual(
    (await request(app).put(`/api/templates/${created.id}`).set(as('Staff')).send(sample())).status,
    403
  );
});

test('archive hides it from the default list and blocks edits (409)', { skip: SKIP }, async () => {
  const { body: created } = await createTemplate();
  const archived = await request(app).patch(`/api/templates/${created.id}/archive`).set(as('Admin'));
  assert.strictEqual(archived.status, 200);
  assert.strictEqual(archived.body.status, 'archived');

  const active = await request(app).get('/api/templates').set(as('Admin'));
  assert.ok(!active.body.some((t) => t.id === created.id));
  const all = await request(app).get('/api/templates?status=all').set(as('Admin'));
  assert.ok(all.body.some((t) => t.id === created.id));

  const edit = await request(app).put(`/api/templates/${created.id}`).set(as('Admin')).send(sample());
  assert.strictEqual(edit.status, 409);

  assert.strictEqual((await request(app).patch(`/api/templates/${created.id}/archive`).set(as('Staff'))).status, 403);
});

test('template changes are written to the audit log', { skip: SKIP }, async () => {
  const { body: created } = await createTemplate();
  await request(app).patch(`/api/templates/${created.id}/archive`).set(as('Admin'));
  const { rows } = await pool.db().query(
    `SELECT action FROM audit_log WHERE entity = 'template' AND entity_id = $1 ORDER BY id`,
    [String(created.id)]
  );
  assert.deepStrictEqual(rows.map((r) => r.action), ['template_create', 'template_archive']);
});
