// Internal notes (issue #21) and ownership / visibility checks (issue #22),
// against a real database. Owner: Hana Anwar.
// Runs only when DATABASE_URL is set (backend/.env, DEV branch).
// Cleans up: deletes the plans and template it creates and deactivates its users.

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
const ids = {};
const userEmails = [];
const planIds = [];
let templateId;
let plan; // { planId, kickoff, upload, credit } for Customer
let otherPlan; // same, for Customer2

const SECRET_NOTE = `Credit limit discussion ${run}`;
const INTERNAL_TASK = `Internal credit check ${run}`;

const as = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
const addNote = (who, planId, body) => request(app).post(`/api/plans/${planId}/notes`).set(as(who)).send(body);
const listNotes = (who, planId, qs = '') => request(app).get(`/api/plans/${planId}/notes${qs}`).set(as(who));

async function makeUser(key, role) {
  const email = `test-note-${key.toLowerCase()}-${run}@example.test`;
  const { rows } = await pool.db().query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, 'not-a-real-hash', $3) RETURNING id`,
    [`Test ${key} ${run}`, email, role]
  );
  userEmails.push(email);
  ids[key] = rows[0].id;
  tokens[key] = signToken(rows[0].id);
}

async function newPlan(customerKey) {
  const res = await request(app)
    .post('/api/plans')
    .set(as('Admin'))
    .send({ templateId, customerId: ids[customerKey], startDate: new Date().toISOString().slice(0, 10), staffOwnerId: ids.Staff });
  assert.strictEqual(res.status, 201);
  planIds.push(res.body.plan.id);
  const [kickoff, upload, credit] = res.body.tasks.map((t) => t.id);
  return { planId: res.body.plan.id, kickoff, upload, credit };
}

before(async () => {
  if (SKIP) return;
  app = require('../src/app');
  pool = require('../src/db/pool');
  ({ signToken } = require('../src/lib/tokens'));
  await makeUser('Admin', 'Admin');
  await makeUser('Staff', 'Staff');
  await makeUser('Staff2', 'Staff');
  await makeUser('Customer', 'Customer');
  await makeUser('Customer2', 'Customer');

  const tpl = await request(app)
    .post('/api/templates')
    .set(as('Admin'))
    .send({
      title: `Note test template ${run}`,
      tasks: [
        { title: 'Kick-off call', offsetDays: 0, visibility: 'customer', actor: 'staff' },
        { title: 'Upload company documents', offsetDays: 3, visibility: 'customer', actor: 'customer' },
        { title: INTERNAL_TASK, offsetDays: 5, visibility: 'internal', actor: 'staff' },
      ],
    });
  assert.strictEqual(tpl.status, 201);
  templateId = tpl.body.id;
  plan = await newPlan('Customer');
  otherPlan = await newPlan('Customer2');
  const first = await addNote('Staff', plan.planId, { body: SECRET_NOTE, taskId: plan.credit });
  assert.strictEqual(first.status, 201);
});

after(async () => {
  if (SKIP) return;
  await pool.db().query('DELETE FROM onboarding_plans WHERE id = ANY($1)', [planIds]);
  await pool.db().query('DELETE FROM templates WHERE id = $1', [templateId]);
  await pool.db().query('UPDATE users SET active = false WHERE email = ANY($1)', [userEmails]);
  await pool.db().end();
});

// ---- #21 internal notes -----------------------------------------------------------------
test('Staff add notes; list is newest first with the author', { skip: SKIP }, async () => {
  const res = await addNote('Admin', plan.planId, { body: '  Second note  ' });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.note.body, 'Second note');
  assert.strictEqual(res.body.note.author.id, ids.Admin);

  const list = await listNotes('Staff2', plan.planId);
  assert.strictEqual(list.status, 200);
  assert.deepStrictEqual(list.body.items.slice(0, 2).map((n) => n.body), ['Second note', SECRET_NOTE]);

  const forTask = await listNotes('Staff2', plan.planId, `?taskId=${plan.credit}`);
  assert.deepStrictEqual(forTask.body.items.map((n) => n.body), [SECRET_NOTE]);
});

test('note rules -> 400 / 404', { skip: SKIP }, async () => {
  assert.strictEqual((await addNote('Staff', plan.planId, { body: '   ' })).status, 400);
  assert.strictEqual((await addNote('Staff', plan.planId, { body: 'x'.repeat(2001) })).status, 400);
  assert.strictEqual((await addNote('Staff', plan.planId, { body: 'x', taskId: otherPlan.kickoff })).status, 400);
  assert.strictEqual((await addNote('Staff', 2147483000, { body: 'x' })).status, 404);
  assert.strictEqual((await listNotes('Staff', 2147483000)).status, 404);
  assert.strictEqual((await listNotes('Staff', plan.planId, '?taskId=abc')).status, 400);
});

test('note text is never written to the audit log', { skip: SKIP }, async () => {
  const { rows } = await pool.db().query(
    `SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'note_create' AND actor_id = $1`,
    [ids.Staff]
  );
  assert.ok(rows[0].n >= 1);
  const leaked = await pool.db().query('SELECT COUNT(*)::int AS n FROM audit_log WHERE entity_id = $1', [SECRET_NOTE.slice(0, 60)]);
  assert.strictEqual(leaked.rows[0].n, 0);
});

test('no new notes on a cancelled plan, but old ones stay readable', { skip: SKIP }, async () => {
  const p = await newPlan('Customer');
  await addNote('Staff', p.planId, { body: 'before cancel' });
  await request(app).patch(`/api/plans/${p.planId}`).set(as('Admin')).send({ status: 'Cancelled', cancelReason: 'Stopped' });
  assert.strictEqual((await addNote('Staff', p.planId, { body: 'after cancel' })).status, 409);
  const list = await listNotes('Staff', p.planId);
  assert.deepStrictEqual(list.body.items.map((n) => n.body), ['before cancel']);
});

// ---- #22 ownership and visibility --------------------------------------------------------
test('Customer cannot read or add notes, even on their own plan (403)', { skip: SKIP }, async () => {
  assert.strictEqual((await listNotes('Customer', plan.planId)).status, 403);
  assert.strictEqual((await addNote('Customer', plan.planId, { body: 'hello' })).status, 403);
});

test('Customer never receives internal tasks or note text in any plan response', { skip: SKIP }, async () => {
  const responses = await Promise.all([
    request(app).get('/api/plans').set(as('Customer')),
    request(app).get(`/api/plans/${plan.planId}`).set(as('Customer')),
    request(app).get(`/api/plans/${plan.planId}/tasks`).set(as('Customer')),
  ]);
  for (const res of responses) {
    assert.strictEqual(res.status, 200);
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes(INTERNAL_TASK), 'internal task leaked');
    assert.ok(!text.includes(SECRET_NOTE), 'note leaked');
  }
});

test("Customer cannot see or change another customer's plan or an internal task (404)", { skip: SKIP }, async () => {
  assert.strictEqual((await request(app).get(`/api/plans/${otherPlan.planId}`).set(as('Customer'))).status, 404);
  assert.strictEqual((await request(app).get(`/api/plans/${otherPlan.planId}/tasks`).set(as('Customer'))).status, 404);
  const patch = (taskId) => request(app).patch(`/api/tasks/${taskId}`).set(as('Customer')).send({ status: 'In Progress' });
  assert.strictEqual((await patch(otherPlan.upload)).status, 404); // other customer's task
  assert.strictEqual((await patch(plan.credit)).status, 404); // internal task in own plan
  const list = await request(app).get('/api/plans').set(as('Customer'));
  assert.ok(list.body.items.every((p) => p.customer.id === ids.Customer));
});

test('Staff cannot change a task assigned to someone else (403)', { skip: SKIP }, async () => {
  const res = await request(app).patch(`/api/tasks/${plan.kickoff}`).set(as('Staff2')).send({ status: 'In Progress' });
  assert.strictEqual(res.status, 403);
  const after = await pool.db().query('SELECT status FROM tasks WHERE id = $1', [plan.kickoff]);
  assert.strictEqual(after.rows[0].status, 'Not Started');
});

test('Customer cannot create, rename, cancel or reassign (403)', { skip: SKIP }, async () => {
  const body = { templateId, customerId: ids.Customer, startDate: '2026-12-01' };
  assert.strictEqual((await request(app).post('/api/plans').set(as('Customer')).send(body)).status, 403);
  assert.strictEqual((await request(app).patch(`/api/plans/${plan.planId}`).set(as('Customer')).send({ title: 'x' })).status, 403);
  assert.strictEqual(
    (await request(app).patch(`/api/plans/${plan.planId}`).set(as('Customer')).send({ status: 'Cancelled', cancelReason: 'x' })).status,
    403
  );
  assert.strictEqual(
    (await request(app).patch(`/api/tasks/${plan.kickoff}/assignment`).set(as('Customer')).send({ assigneeId: ids.Staff2 })).status,
    403
  );
});

test('not logged in -> 401 on every plan, task and note endpoint', { skip: SKIP }, async () => {
  const calls = [
    request(app).get('/api/plans'),
    request(app).get(`/api/plans/${plan.planId}`),
    request(app).patch(`/api/plans/${plan.planId}`).send({ title: 'x' }),
    request(app).patch(`/api/tasks/${plan.kickoff}`).send({ status: 'In Progress' }),
    request(app).patch(`/api/tasks/${plan.kickoff}/assignment`).send({ assigneeId: ids.Staff2 }),
    request(app).get(`/api/plans/${plan.planId}/notes`),
    request(app).post(`/api/plans/${plan.planId}/notes`).send({ body: 'x' }),
  ];
  for (const res of await Promise.all(calls)) assert.strictEqual(res.status, 401);
});
