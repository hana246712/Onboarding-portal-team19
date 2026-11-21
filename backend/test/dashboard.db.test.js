// Dashboard endpoint tests against a real database (issue #36). Owner: Jana Hossam.
// Runs only when DATABASE_URL is set (backend/.env, DEV branch).
// Cleans up: deletes the plan and template it creates and deactivates its users.

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
const run = crypto.randomBytes(4).toString('hex');   // makes test emails unique
const tokens = {};
const userIds = {};
const userEmails = [];
const created = { templateId: null, planId: null };

const as = (role) => ({ Authorization: `Bearer ${tokens[role]}` });
const summary = (role) => request(app).get('/api/dashboard/summary').set(as(role));

before(async () => {
  if (SKIP) return;
  app = require('../src/app');
  pool = require('../src/db/pool');
  ({ signToken } = require('../src/lib/tokens'));
  for (const role of ['Admin', 'Staff', 'Customer']) {
    const email = `test-dash-${role.toLowerCase()}-${run}@example.test`;
    const { rows } = await pool.db().query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, 'not-a-real-hash', $3) RETURNING id`,
      [`Test ${role}`, email, role]
    );
    userEmails.push(email);
    userIds[role] = rows[0].id;
    tokens[role] = signToken(rows[0].id);
  }
});

after(async () => {
  if (SKIP) return;
  if (created.planId) await pool.db().query('DELETE FROM onboarding_plans WHERE id = $1', [created.planId]);
  if (created.templateId) await pool.db().query('DELETE FROM templates WHERE id = $1', [created.templateId]);
  await pool.db().query('UPDATE users SET active = false WHERE email = ANY($1)', [userEmails]);
  await pool.db().end();
});

test('summary: not logged in -> 401, Customer -> 403', { skip: SKIP }, async () => {
  assert.strictEqual((await request(app).get('/api/dashboard/summary')).status, 401);
  assert.strictEqual((await summary('Customer')).status, 403);
});

test('summary: Admin and Staff -> 200 with the right shape', { skip: SKIP }, async () => {
  for (const role of ['Admin', 'Staff']) {
    const res = await summary(role);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(Object.keys(res.body.plans).sort(), ['active', 'cancelled', 'completed']);
    assert.deepStrictEqual(Object.keys(res.body.tasks).sort(), ['done', 'inProgress', 'notStarted']);
    assert.strictEqual(typeof res.body.overdueTasks, 'number');
  }
});

test('summary: counts go up correctly when a plan with 3 tasks is added', { skip: SKIP }, async () => {
  const before = (await summary('Admin')).body;

  // a template, a plan and 3 tasks: 1 Done, 1 overdue (Not Started, due 2 days ago), 1 In Progress
  const tpl = await pool.db().query(
    `INSERT INTO templates (title, created_by) VALUES ($1, $2) RETURNING id`,
    [`Dashboard test ${run}`, userIds.Admin]
  );
  created.templateId = tpl.rows[0].id;
  const plan = await pool.db().query(
    `INSERT INTO onboarding_plans (template_id, template_version, customer_id, title, start_date, created_by)
     VALUES ($1, 1, $2, $3, CURRENT_DATE - 10, $4) RETURNING id`,
    [created.templateId, userIds.Customer, `Dashboard plan ${run}`, userIds.Admin]
  );
  created.planId = plan.rows[0].id;
  await pool.db().query(
    `INSERT INTO tasks (plan_id, title, position, visibility, actor, due_date, status, completed_at) VALUES
       ($1, 'Done task',        1, 'customer', 'staff', CURRENT_DATE - 5, 'Done',        now()),
       ($1, 'Overdue task',     2, 'customer', 'staff', CURRENT_DATE - 2, 'Not Started', NULL),
       ($1, 'In progress task', 3, 'internal', 'staff', CURRENT_DATE + 5, 'In Progress', NULL)`,
    [created.planId]
  );

  const after = (await summary('Admin')).body;
  assert.strictEqual(after.plans.active - before.plans.active, 1);
  assert.strictEqual(after.tasks.done - before.tasks.done, 1);
  assert.strictEqual(after.tasks.notStarted - before.tasks.notStarted, 1);
  assert.strictEqual(after.tasks.inProgress - before.tasks.inProgress, 1);
  assert.strictEqual(after.overdueTasks - before.overdueTasks, 1);
});

test('summary: no emails in the response', { skip: SKIP }, async () => {
  const res = await summary('Admin');
  assert.ok(!JSON.stringify(res.body).includes('@'));
});

