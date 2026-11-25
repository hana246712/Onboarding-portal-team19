// Unit tests for the plan screen rules in frontend/js/planView.js (issue #23).
// No browser or database needed.

const { test } = require('node:test');
const assert = require('node:assert');
const v = require('../../frontend/js/planView.js');

const admin = { id: 1, role: 'Admin' };
const staff = { id: 2, role: 'Staff' };
const staff2 = { id: 3, role: 'Staff' };
const customer = { id: 4, role: 'Customer' };
const otherCustomer = { id: 5, role: 'Customer' };

const plan = (status = 'Active') => ({ status, customer: { id: 4 } });
const staffTask = (status = 'Not Started') => ({ actor: 'staff', status, assignee: { id: 2 } });
const customerTask = (status = 'Not Started') => ({ actor: 'customer', status, assignee: { id: 4 } });

test('next step: Not Started -> In Progress -> Done -> nothing', () => {
  assert.strictEqual(v.nextStatus({ status: 'Not Started' }), 'In Progress');
  assert.strictEqual(v.nextStatus({ status: 'In Progress' }), 'Done');
  assert.strictEqual(v.nextStatus({ status: 'Done' }), null);
  assert.strictEqual(v.actionLabel('In Progress'), 'Start');
  assert.strictEqual(v.actionLabel('Done'), 'Mark done');
});

test('customer task: only the plan\'s customer sees Start / Mark done', () => {
  assert.ok(v.canAdvance(customer, plan(), customerTask()));
  for (const user of [admin, staff, otherCustomer]) {
    assert.ok(!v.canAdvance(user, plan(), customerTask()), user.role);
  }
});

test('staff task: the assigned Staff user or any Admin', () => {
  assert.ok(v.canAdvance(staff, plan(), staffTask()));
  assert.ok(v.canAdvance(admin, plan(), staffTask()));
  assert.ok(!v.canAdvance(staff2, plan(), staffTask()));
  assert.ok(!v.canAdvance(customer, plan(), staffTask()));
  assert.ok(!v.canAdvance(staff, plan(), { actor: 'staff', status: 'Not Started', assignee: null }));
});

test('no buttons on finished tasks or on completed / cancelled plans', () => {
  assert.ok(!v.canAdvance(staff, plan(), staffTask('Done')));
  assert.ok(!v.canAdvance(staff, plan('Cancelled'), staffTask()));
  assert.ok(!v.canAdvance(customer, plan('Completed'), customerTask()));
});

test('reopen: Admin only, finished task, plan not cancelled', () => {
  assert.ok(v.canReopen(admin, plan('Completed'), customerTask('Done')));
  assert.ok(v.canReopen(admin, plan(), staffTask('Done')));
  assert.ok(!v.canReopen(staff, plan(), staffTask('Done')));
  assert.ok(!v.canReopen(customer, plan(), customerTask('Done')));
  assert.ok(!v.canReopen(admin, plan('Cancelled'), staffTask('Done')));
  assert.ok(!v.canReopen(admin, plan(), staffTask('In Progress')));
});

test('reassign: Admin, open staff task, active plan', () => {
  assert.ok(v.canReassign(admin, plan(), staffTask()));
  assert.ok(!v.canReassign(admin, plan(), customerTask()));
  assert.ok(!v.canReassign(admin, plan(), staffTask('Done')));
  assert.ok(!v.canReassign(admin, plan('Cancelled'), staffTask()));
  assert.ok(!v.canReassign(staff, plan(), staffTask())); // user list is Admin-only
});

test('plan management and notes: Admin and Staff only; creating plans: Admin only', () => {
  assert.ok(v.canManagePlan(staff, plan()));
  assert.ok(!v.canManagePlan(staff, plan('Cancelled')));
  assert.ok(!v.canManagePlan(customer, plan()));
  assert.ok(v.canSeeNotes(admin) && v.canSeeNotes(staff) && !v.canSeeNotes(customer));
  assert.ok(v.canCreatePlan(admin) && !v.canCreatePlan(staff) && !v.canCreatePlan(customer));
});

test('formatDay reads YYYY-MM-DD without a time-zone shift', () => {
  assert.strictEqual(v.formatDay('2026-12-01'), '1 Dec 2026');
  assert.strictEqual(v.formatDay('2027-01-31'), '31 Jan 2027');
  assert.strictEqual(v.formatDay(''), '');
  assert.strictEqual(v.formatDay(null), '');
});

test('progress, status classes and the ?id= value from the URL', () => {
  assert.strictEqual(v.progressPercent({ done: 1, total: 3 }), 33);
  assert.strictEqual(v.progressPercent({ done: 0, total: 0 }), 0);
  assert.strictEqual(v.statusClass('Not Started'), 'status-not-started');
  assert.strictEqual(v.planIdFromSearch('?id=12'), 12);
  for (const bad of ['', '?id=abc', '?id=0', '?id=-1', '?id=12abc', '?id=99999999999']) {
    assert.strictEqual(v.planIdFromSearch(bad), null, bad);
  }
});
