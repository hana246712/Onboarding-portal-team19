// Unit tests for plan events (issue #26). No database, AWS or network:
// the SQS client and the database are replaced by small fakes.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// Fake SQS client, installed before planEvents loads it.
const sent = [];
let queueDown = false;
const sqsPath = path.join(__dirname, '..', 'src', 'lib', 'sqs.js');
require.cache[sqsPath] = {
  id: sqsPath, filename: sqsPath, loaded: true,
  exports: {
    sendEvents: async (url, events) => {
      if (queueDown) throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'NetworkingError' });
      sent.push({ url, events });
    },
  },
};

// Fake database: remembers the inserts.
const inserts = [];
const poolPath = path.join(__dirname, '..', 'src', 'db', 'pool.js');
const fakeDb = { query: async (sql, params) => { inserts.push(params); return { rowCount: 1 }; } };
require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: { db: () => fakeDb } };

const pe = require('../src/lib/planEvents');
const QUEUE = 'http://localhost:4566/000000000000/team19-plan-events';

beforeEach(() => {
  sent.length = 0;
  inserts.length = 0;
  queueDown = false;
  delete process.env.PLAN_EVENTS_QUEUE_URL;
});

test('task.assigned: one event per person, ids only', () => {
  const events = pe.taskAssigned({ planId: 12, assigneeIds: [5, 31, 5, null] });
  assert.deepStrictEqual(events, [
    { type: 'task.assigned', planId: 12, taskId: null, assigneeId: 5 },
    { type: 'task.assigned', planId: 12, taskId: null, assigneeId: 31 },
  ]);
  assert.deepStrictEqual(pe.planCompleted({ planId: 12, customerId: 31 }), [{ type: 'plan.completed', planId: 12, customerId: 31 }]);
});

test('no queue (live site): record() saves notifications in the transaction, publish() sends nothing', async () => {
  const events = pe.taskAssigned({ planId: 12, taskId: 140, assigneeIds: [5] });
  assert.strictEqual(await pe.record(fakeDb, events), 1);
  assert.deepStrictEqual(inserts, [[5, 12, 140]]);
  assert.deepStrictEqual(await pe.publish(events), { sent: 0 });
  assert.strictEqual(sent.length, 0);
});

test('queue set (Floci): record() saves nothing, publish() sends to the queue', async () => {
  process.env.PLAN_EVENTS_QUEUE_URL = QUEUE;
  const events = [...pe.taskAssigned({ planId: 12, assigneeIds: [5, 31] }), ...pe.planCompleted({ planId: 12, customerId: 31 })];
  assert.strictEqual(await pe.record(fakeDb, events), 0);
  assert.deepStrictEqual(await pe.publish(events), { sent: 3 });
  assert.strictEqual(sent[0].url, QUEUE);
  assert.strictEqual(inserts.length, 0);
});

test('queue down: publish() writes the notifications itself and does not throw', async () => {
  process.env.PLAN_EVENTS_QUEUE_URL = QUEUE;
  queueDown = true;
  const events = [...pe.taskAssigned({ planId: 12, assigneeIds: [5] }), ...pe.planCompleted({ planId: 12, customerId: 31 })];
  assert.deepStrictEqual(await pe.publish(events), { sent: 0, fallback: 2 });
  assert.deepStrictEqual(inserts, [[5, 12, null]]); // plan.completed stores nothing
});

test('worker side: parseEvent keeps only valid events and only their own fields', () => {
  assert.deepStrictEqual(
    pe.parseEvent('{"type":"task.assigned","planId":1,"taskId":null,"assigneeId":2,"email":"a@b.test","isAdmin":true}'),
    { type: 'task.assigned', planId: 1, taskId: null, assigneeId: 2 }
  );
  assert.deepStrictEqual(pe.parseEvent('{"type":"plan.completed","planId":1,"customerId":3}'), { type: 'plan.completed', planId: 1, customerId: 3 });
  for (const bad of [
    'not json',
    '[]',
    'null',
    '{"type":"task.assigned","planId":"1","taskId":null,"assigneeId":2}', // id as text
    '{"type":"task.assigned","planId":1,"taskId":0,"assigneeId":2}',
    '{"type":"task.assigned","planId":1,"assigneeId":2}', // taskId missing
    '{"type":"plan.completed","planId":1}',
    '{"type":"user.deleted","planId":1}',
    '{"type":"task.assigned","planId":99999999999,"taskId":null,"assigneeId":2}',
  ]) {
    assert.strictEqual(pe.parseEvent(bad), null, bad);
  }
});
