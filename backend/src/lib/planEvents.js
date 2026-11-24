// Plan events - Owner: Hana Anwar (issues #18, #26).
//
// One place where Plan & Task Management tells the rest of the system that
// something happened (docs/api/plans-tasks-notes.md, section 5):
//
//   task.assigned   { type, planId, taskId, assigneeId }   (taskId null on plan creation)
//   plan.completed  { type, planId, customerId }
//
// Payloads carry ids only: never emails, names, note text or tokens.
//
// Two ways of delivering them, chosen by one setting:
//
//   PLAN_EVENTS_QUEUE_URL not set (the live site on Vercel + Neon):
//     record() writes the in-app notification straight away, inside the
//     caller's transaction, so it is saved together with the change.
//
//   PLAN_EVENTS_QUEUE_URL set (the AWS version on Floci, infra/floci/sqs):
//     publish() sends each event to the Amazon SQS queue AFTER the change is
//     committed (a rolled-back change never sends anything). The notifier
//     worker (scripts/plan-events-worker.js) reads the queue and writes the
//     notifications as the notifier database role. If the queue cannot be
//     reached, publish() writes the notifications itself instead, so an
//     outage never loses them and never fails the user's request.
//
// Writing a notification twice is harmless: the unique index
// notifications_once_per_day + ON CONFLICT DO NOTHING keep one per day,
// which also makes the worker safe with SQS's at-least-once delivery.

const pool = require('../db/pool');

const queueUrl = () => process.env.PLAN_EVENTS_QUEUE_URL || '';
const usesQueue = () => Boolean(queueUrl());

// ---- building events ---------------------------------------------------------
// One event per assignee (duplicates and empty owners dropped).
function taskAssigned({ planId, taskId = null, assigneeIds }) {
  return [...new Set(assigneeIds.filter(Boolean))].map((assigneeId) => ({
    type: 'task.assigned',
    planId,
    taskId,
    assigneeId,
  }));
}

function planCompleted({ planId, customerId }) {
  return [{ type: 'plan.completed', planId, customerId }];
}

// ---- checking events (the worker reads them from a queue) --------------------
const isId = (v) => Number.isInteger(v) && v > 0 && v <= 2147483647;

// Returns a clean event, or null when the message is not one of ours.
// Only the listed fields are kept; anything else in the message is dropped.
function parseEvent(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (body.type === 'task.assigned') {
    if (!isId(body.planId) || !isId(body.assigneeId)) return null;
    if (body.taskId !== null && !isId(body.taskId)) return null;
    return { type: body.type, planId: body.planId, taskId: body.taskId, assigneeId: body.assigneeId };
  }
  if (body.type === 'plan.completed') {
    if (!isId(body.planId) || !isId(body.customerId)) return null;
    return { type: body.type, planId: body.planId, customerId: body.customerId };
  }
  return null;
}

// ---- delivering events ---------------------------------------------------------
// Writes the in-app notification for each task.assigned event.
// plan.completed stores nothing: the notifications table has no "completed"
// type, and the dashboard reads the plan's status directly.
async function storeNotifications(db, events) {
  let stored = 0;
  for (const e of events) {
    if (e.type !== 'task.assigned') continue;
    const res = await db.query(
      `INSERT INTO notifications (user_id, plan_id, task_id, type, channel)
       VALUES ($1, $2, $3, 'assigned', 'in_app')
       ON CONFLICT DO NOTHING`,
      [e.assigneeId, e.planId, e.taskId]
    );
    stored += res.rowCount;
  }
  return stored;
}

// Inside the transaction. Without a queue this is where notifications are saved.
async function record(client, events) {
  if (usesQueue()) return 0;
  return storeNotifications(client, events);
}

// After the commit. With a queue, sends the events; on failure falls back to
// writing the notifications directly (app_rw may add notifications).
async function publish(events) {
  if (!usesQueue() || events.length === 0) return { sent: 0 };
  try {
    const sqs = require('./sqs'); // loaded only when a queue is configured
    await sqs.sendEvents(queueUrl(), events);
    return { sent: events.length };
  } catch (err) {
    console.error(`plan events: queue unavailable (${err.name || 'Error'}); writing notifications directly`);
    await storeNotifications(pool.db(), events);
    return { sent: 0, fallback: events.length };
  }
}

module.exports = { taskAssigned, planCompleted, parseEvent, record, publish, storeNotifications, usesQueue };
