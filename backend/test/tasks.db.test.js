// Task status, plan status rules and reassignment, against a real database
// (issues #19, #20). Owner: Hana Anwar.
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

const as = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
const setStatus = (who, taskId, status) => request(app).patch(`/api/tasks/${taskId}`).set(as(who)).send({ status });
const reassign = (who, taskId, assigneeId) =>
  request(app).patch(`/api/tasks/${taskId}/assignment`).set(as(who)).send({ assigneeId });
const updatePlan = (who, planId, body) => request(app).patch(`/api/plans/${planId}`).set(as(who)).send(body);

async function makeUser(key, role, active = true) {
  const email = `test-task-${key.toLowerCase()}-${run}@example.test`;
  const { rows } = await pool.db().query(
    `INSERT INTO users (name, email, password_hash, role, active)
     VALUES ($1, $2, 'not-a-real-hash', $3, $4) RETURNING id`,
    [`Test ${key} ${run}`, email, role, active]
  );
  userEmails.push(email);
  ids[key] = rows[0].id;
  tokens[key] = signToken(rows[0].id);
}

// New plan for Customer; staff tasks owned by Staff.
// Returns { planId, kickoff, upload, credit } (task ids, by position).
async function newPlan() {
  const res = await request(app)
    .post('/api/plans')
    .set(as('Admin'))
    .send({ templateId, customerId: ids.Customer, startDate: new Date().toISOString().slice(0, 10), staffOwnerId: ids.Staff });
  assert.strictEqual(res.status, 201);
  planIds.push(res.body.plan.id);
  const [kickoff, upload, credit] = res.body.tasks.map((t) => t.id);
  return { planId: res.body.plan.id, kickoff, upload, credit };
}

const planStatus = async (planId) =>
  (await pool.db().query('SELECT status FROM onboarding_plans WHERE id = $1', [planId])).rows[0].status;

before(async () => {
  if (SKIP) return;
  app = require('../src/app');
  pool = require('../src/db/pool');
  ({ signToken } = require('../src/lib/tokens'));
  await makeUser('Admin', 'Admin');
  await makeUser('Staff', 'Staff');
  await makeUser('Staff2', 'Staff');
  await makeUser('Customer', 'Customer');
  await makeUser('GoneStaff', 'Staff', false);

  const tpl = await request(app)
    .post('/api/templates')
    .set(as('Admin'))
    .send({
      title: `Task test template ${run}`,
      tasks: [
        { title: 'Kick-off call', offsetDays: 0, visibility: 'customer', actor: 'staff' },
        { title: 'Upload company documents', offsetDays: 3, visibility: 'customer', actor: 'customer' },
        { title: 'Internal credit check', offsetDays: 5, visibility: 'internal', actor: 'staff' },
      ],
    });
  assert.strictEqual(tpl.status, 201);
  templateId = tpl.body.id;
});

after(async () => {
  if (SKIP) return;
  await pool.db().query('DELETE FROM onboarding_plans WHERE id = ANY($1)', [planIds]);
  await pool.db().query('DELETE FROM templates WHERE id = $1', [templateId]);
  await pool.db().query('UPDATE users SET active = false WHERE email = ANY($1)', [userEmails]);
  await pool.db().end();
});

// ---- #19 status changes -----------------------------------------------------------
test('owner moves a task forward one step at a time', { skip: SKIP }, async () => {
  const p = await newPlan();
  let res = await setStatus('Staff', p.kickoff, 'In Progress');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.task.status, 'In Progress');
  assert.strictEqual(res.body.planStatus, 'Active');

  res = await setStatus('Staff', p.kickoff, 'Done');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.task.completedAt);
});

test('status changes outside the table -> 400', { skip: SKIP }, async () => {
  const p = await newPlan();
  assert.strictEqual((await setStatus('Staff', p.kickoff, 'Done')).status, 400); // skips In Progress
  assert.strictEqual((await setStatus('Staff', p.kickoff, 'Not Started')).status, 400); // same status
  assert.strictEqual((await setStatus('Staff', p.kickoff, 'Finished')).status, 400); // not a status
  await setStatus('Staff', p.kickoff, 'In Progress');
  assert.strictEqual((await setStatus('Staff', p.kickoff, 'Not Started')).status, 400); // no going back
});

test('who may change a task: customer task -> its customer; staff task -> assignee or Admin', { skip: SKIP }, async () => {
  const p = await newPlan();
  assert.strictEqual((await setStatus('Staff', p.upload, 'In Progress')).status, 403);
  assert.strictEqual((await setStatus('Admin', p.upload, 'In Progress')).status, 403);
  assert.strictEqual((await setStatus('Customer', p.upload, 'In Progress')).status, 200);

  assert.strictEqual((await setStatus('Customer', p.kickoff, 'In Progress')).status, 403); // visible, not theirs
  assert.strictEqual((await setStatus('Staff2', p.kickoff, 'In Progress')).status, 403); // not the assignee
  assert.strictEqual((await setStatus('Admin', p.kickoff, 'In Progress')).status, 200);
});

test('last task Done -> plan Completed; Admin reopen -> Active again', { skip: SKIP }, async () => {
  const p = await newPlan();
  for (const [who, task] of [['Staff', p.kickoff], ['Customer', p.upload], ['Staff', p.credit]]) {
    assert.strictEqual((await setStatus(who, task, 'In Progress')).status, 200);
    const res = await setStatus(who, task, 'Done');
    assert.strictEqual(res.status, 200);
  }
  assert.strictEqual(await planStatus(p.planId), 'Completed');

  // Only an Admin can reopen, and it reopens the plan too.
  assert.strictEqual((await setStatus('Staff', p.credit, 'In Progress')).status, 403);
  assert.strictEqual((await setStatus('Customer', p.upload, 'In Progress')).status, 403);
  const res = await setStatus('Admin', p.upload, 'In Progress');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.planStatus, 'Active');
  assert.strictEqual(res.body.task.completedAt, null);
  assert.strictEqual(await planStatus(p.planId), 'Active');
});

test('auto-complete and reopen are written to the audit log', { skip: SKIP }, async () => {
  const p = await newPlan();
  for (const [who, task] of [['Staff', p.kickoff], ['Customer', p.upload], ['Staff', p.credit]]) {
    await setStatus(who, task, 'In Progress');
    await setStatus(who, task, 'Done');
  }
  await setStatus('Admin', p.credit, 'In Progress');
  const { rows } = await pool.db().query(
    `SELECT action FROM audit_log WHERE entity = 'plan' AND entity_id = $1 ORDER BY id`,
    [String(p.planId)]
  );
  assert.deepStrictEqual(rows.map((r) => r.action), ['plan_create', 'plan_complete', 'plan_reopen']);
});

// ---- #19 rename and cancel --------------------------------------------------------------
test('rename and cancel a plan; Customer cannot', { skip: SKIP }, async () => {
  const p = await newPlan();
  assert.strictEqual((await updatePlan('Customer', p.planId, { title: 'x' })).status, 403);
  assert.strictEqual((await updatePlan('Staff', p.planId, {})).status, 400);
  assert.strictEqual((await updatePlan('Staff', p.planId, { status: 'Completed' })).status, 400);
  assert.strictEqual((await updatePlan('Staff', p.planId, { status: 'Cancelled' })).status, 400); // no reason

  let res = await updatePlan('Staff', p.planId, { title: `Renamed ${run}` });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.plan.title, `Renamed ${run}`);

  res = await updatePlan('Admin', p.planId, { status: 'Cancelled', cancelReason: 'Customer postponed' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.plan.status, 'Cancelled');
  assert.strictEqual(res.body.plan.cancelReason, 'Customer postponed');

  const asCustomer = await request(app).get(`/api/plans/${p.planId}`).set(as('Customer'));
  assert.strictEqual(asCustomer.body.plan.status, 'Cancelled');
  assert.strictEqual(asCustomer.body.plan.cancelReason, null);
});

test('a cancelled plan is read-only (409)', { skip: SKIP }, async () => {
  const p = await newPlan();
  await updatePlan('Admin', p.planId, { status: 'Cancelled', cancelReason: 'Stopped' });
  assert.strictEqual((await updatePlan('Admin', p.planId, { status: 'Cancelled', cancelReason: 'again' })).status, 409);
  assert.strictEqual((await updatePlan('Staff', p.planId, { title: 'x' })).status, 409);
  assert.strictEqual((await setStatus('Staff', p.kickoff, 'In Progress')).status, 409);
  assert.strictEqual((await reassign('Admin', p.kickoff, ids.Staff2)).status, 409);
});

// ---- #20 reassignment -------------------------------------------------------------------
test('reassign a staff task: new owner notified, old owner loses it', { skip: SKIP }, async () => {
  const p = await newPlan();
  const res = await reassign('Staff', p.kickoff, ids.Staff2);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.task.assignee.id, ids.Staff2);

  const note = await pool.db().query(
    `SELECT 1 FROM notifications WHERE user_id = $1 AND task_id = $2 AND type = 'assigned'`,
    [ids.Staff2, p.kickoff]
  );
  assert.strictEqual(note.rowCount, 1);

  assert.strictEqual((await setStatus('Staff', p.kickoff, 'In Progress')).status, 403);
  assert.strictEqual((await setStatus('Staff2', p.kickoff, 'In Progress')).status, 200);
});

test('reassignment rules -> 400 / 403 / 409', { skip: SKIP }, async () => {
  const p = await newPlan();
  assert.strictEqual((await reassign('Customer', p.kickoff, ids.Staff2)).status, 403);
  assert.strictEqual((await reassign('Staff', p.upload, ids.Staff2)).status, 400); // customer task
  assert.strictEqual((await reassign('Staff', p.kickoff, ids.Staff)).status, 400); // same person
  assert.strictEqual((await reassign('Staff', p.kickoff, ids.Customer)).status, 400); // not staff
  assert.strictEqual((await reassign('Staff', p.kickoff, ids.GoneStaff)).status, 400); // deactivated
  assert.strictEqual((await reassign('Staff', p.kickoff, 'x')).status, 400);

  await setStatus('Staff', p.kickoff, 'In Progress');
  await setStatus('Staff', p.kickoff, 'Done');
  assert.strictEqual((await reassign('Admin', p.kickoff, ids.Staff2)).status, 409); // finished
});

test('task changes are audited, including denied attempts', { skip: SKIP }, async () => {
  const p = await newPlan();
  await setStatus('Staff2', p.kickoff, 'In Progress'); // denied: not the assignee
  await reassign('Admin', p.kickoff, ids.Staff2);
  const { rows } = await pool.db().query(
    `SELECT action, result FROM audit_log WHERE entity = 'task' AND entity_id = $1 ORDER BY id`,
    [String(p.kickoff)]
  );
  assert.deepStrictEqual(rows, [
    { action: 'task_status', result: 'denied' },
    { action: 'task_reassign', result: 'allowed' },
  ]);
});
