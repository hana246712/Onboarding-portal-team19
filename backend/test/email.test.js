// Unit tests for the Brevo email helper (src/lib/email.js).
// No database and no network: Brevo and the database are both fakes,
// so no real email is ever sent and no key is needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BREVO_URL, emailSettings, buildDueEmail, sendEmail, remainingToday, sendDueEmails,
} = require('../src/lib/email');

const ON = { EMAIL_ENABLED: 'true', BREVO_API_KEY: 'test-key-not-real', EMAIL_FROM: 'sender@example.test' };

// A fake Brevo: records every call and answers with the given status.
function fakeBrevo(status = 201) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => { throw new Error('the reply body must never be read'); },
      text: () => { throw new Error('the reply body must never be read'); },
    };
  };
  return { calls, fetchImpl };
}

// A fake notifier database: pending rows, today's sent count, and the
// once-per-day rule for email records (a second claim of the same key fails).
function fakeDb({ pending = [], sentToday = 0, failUpdate = false } = {}) {
  const records = new Map();
  let nextId = 1;
  const db = {
    records,
    queries: [],
    async query(sql, params = []) {
      db.queries.push(sql);
      if (sql.includes('COUNT(*)')) return { rows: [{ n: sentToday }] };
      if (sql.includes('FROM notifications n')) return { rows: pending };
      if (sql.includes('INSERT INTO notifications')) {
        const key = params.slice(0, 4).join('/');
        if (records.has(key)) return { rows: [] };
        const id = nextId++;
        records.set(key, { id, status: params[4] });
        return { rows: [{ id }] };
      }
      if (sql.startsWith('UPDATE notifications')) {
        if (failUpdate) throw Object.assign(new Error('permission denied'), { code: '42501' });
        for (const r of records.values()) if (r.id === params[0]) r.status = 'sent';
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return db;
}

const row = (n, extra = {}) => ({
  user_id: n, plan_id: 70, task_id: 100 + n, type: 'overdue', email: `owner${n}@example.test`,
  task_title: `Task ${n}`, plan_title: 'Plan A', due_date: '2026-11-20', ...extra,
});

test('settings: only EMAIL_ENABLED=true turns email on; key and sender come from the environment', () => {
  assert.equal(emailSettings({}).enabled, false);
  assert.equal(emailSettings({ EMAIL_ENABLED: 'yes' }).enabled, false);
  assert.equal(emailSettings({ EMAIL_ENABLED: 'TRUE' }).enabled, false);
  assert.deepEqual(emailSettings(ON), { enabled: true, apiKey: 'test-key-not-real', from: 'sender@example.test' });
});

test('message: only task title, plan title, due date and the plan link', () => {
  const m = buildDueEmail({ taskTitle: 'Sign contract', planTitle: 'Acme onboarding', dueDate: '2026-11-20', planId: 42 });
  assert.equal(m.subject, 'Overdue task: Sign contract');
  assert.match(m.text, /Task: Sign contract/);
  assert.match(m.text, /Plan: Acme onboarding/);
  assert.match(m.text, /Due date: 2026-11-20/);
  assert.match(m.text, /https:\/\/team19-web\.vercel\.app\/plans\.html\?id=42/);
  assert.ok(!m.text.includes('@'), 'no email address in the text');
});

test('message: a title with line breaks or control characters stays on one line', () => {
  const m = buildDueEmail({ taskTitle: 'A\r\nBcc: x\u0007', planTitle: 'P\nQ', dueDate: '2026-11-20', planId: 1 });
  assert.ok(!/[\r\n]/.test(m.subject));
  assert.match(m.text, /Task: A Bcc: x\n/);
  assert.match(m.text, /Plan: P Q\n/);
});

test('send: the request Brevo gets (key in the api-key header, plain text only)', async () => {
  const brevo = fakeBrevo(201);
  const result = await sendEmail(
    { to: 'owner@example.test', subject: 'S', text: 'T' },
    { apiKey: 'test-key-not-real', from: 'sender@example.test', fetchImpl: brevo.fetchImpl }
  );
  assert.deepEqual(result, { ok: true });
  const [call] = brevo.calls;
  assert.equal(call.url, BREVO_URL);
  assert.equal(call.url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers['api-key'], 'test-key-not-real');
  assert.equal(call.body.sender.email, 'sender@example.test');
  assert.deepEqual(call.body.to, [{ email: 'owner@example.test' }]);
  assert.equal(call.body.textContent, 'T');
  assert.equal(call.body.htmlContent, undefined, 'no HTML');
});

test('send: a Brevo error returns the status and never throws or reads the body', async () => {
  const brevo = fakeBrevo(401);
  const result = await sendEmail({ to: 'a@example.test', subject: 'S', text: 'T' }, { apiKey: 'k', from: 'f@example.test', fetchImpl: brevo.fetchImpl });
  assert.deepEqual(result, { ok: false, status: 401 });
});

test('send: a timeout or network error returns ok: false and never throws', async () => {
  // Never answers, like a Brevo that hangs. The timer only keeps the test
  // process alive (a real request would, through its open connection).
  const hang = (url, options) => new Promise((resolve, reject) => {
    const keepAlive = setTimeout(() => {}, 10000);
    options.signal.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(options.signal.reason);
    });
  });
  const slow = await sendEmail({ to: 'a@example.test', subject: 'S', text: 'T' }, { apiKey: 'k', from: 'f@example.test', fetchImpl: hang, timeoutMs: 20 });
  assert.deepEqual(slow, { ok: false, status: 'timeout' });

  const down = await sendEmail({ to: 'a@example.test', subject: 'S', text: 'T' }, {
    apiKey: 'k', from: 'f@example.test', fetchImpl: async () => { throw new TypeError('fetch failed'); },
  });
  assert.deepEqual(down, { ok: false, status: 'network' });
});

test('daily limit: never more than 300 a day', () => {
  assert.equal(remainingToday(0), 250);
  assert.equal(remainingToday(240), 10);
  assert.equal(remainingToday(260), 0);
  assert.equal(remainingToday(0, 1000), 300, 'a higher setting is capped at Brevo\'s 300');
});

test('job step: email disabled -> no database work and no request to Brevo', async () => {
  const brevo = fakeBrevo();
  const db = fakeDb({ pending: [row(1)] });
  const counts = await sendDueEmails(db, { env: {}, fetchImpl: brevo.fetchImpl });
  assert.deepEqual(counts, { enabled: false, sent: 0, failed: 0, skipped: 0, deferred: 0 });
  assert.equal(brevo.calls.length, 0);
  assert.equal(db.queries.length, 0);
});

test('job step: sends one email per pending notice and records it as sent', async () => {
  const brevo = fakeBrevo(201);
  const db = fakeDb({ pending: [row(1), row(2)] });
  const counts = await sendDueEmails(db, { env: ON, fetchImpl: brevo.fetchImpl });
  assert.deepEqual(counts, { enabled: true, sent: 2, failed: 0, skipped: 0, deferred: 0 });
  assert.deepEqual(brevo.calls.map((c) => c.body.to[0].email), ['owner1@example.test', 'owner2@example.test']);
  assert.deepEqual([...db.records.values()].map((r) => r.status), ['sent', 'sent']);
});

test('job step: a notice already recorded today is never sent again', async () => {
  const brevo = fakeBrevo(201);
  const db = fakeDb({ pending: [row(1)] });
  await sendDueEmails(db, { env: ON, fetchImpl: brevo.fetchImpl });
  await sendDueEmails(db, { env: ON, fetchImpl: brevo.fetchImpl });   // same row offered again
  assert.equal(brevo.calls.length, 1);
});

test('job step: Brevo errors are counted and recorded as failed, never thrown', async () => {
  const brevo = fakeBrevo(500);
  const db = fakeDb({ pending: [row(1), row(2)] });
  const counts = await sendDueEmails(db, { env: ON, fetchImpl: brevo.fetchImpl });
  assert.deepEqual(counts, { enabled: true, sent: 0, failed: 2, skipped: 0, deferred: 0 });
  assert.deepEqual([...db.records.values()].map((r) => r.status), ['failed', 'failed']);
});

test('job step: after 3 failures in a row the rest waits for the next run', async () => {
  const brevo = fakeBrevo(503);
  const db = fakeDb({ pending: [row(1), row(2), row(3), row(4), row(5)] });
  const counts = await sendDueEmails(db, { env: ON, fetchImpl: brevo.fetchImpl });
  assert.equal(counts.failed, 3);
  assert.equal(counts.deferred, 2);
  assert.equal(brevo.calls.length, 3);
  assert.equal(db.records.size, 3, 'the deferred ones are not recorded, so the next run can send them');
});

test('job step: missing key or sender -> recorded as skipped, nothing sent', async () => {
  for (const env of [{ EMAIL_ENABLED: 'true', EMAIL_FROM: 'sender@example.test' }, { EMAIL_ENABLED: 'true', BREVO_API_KEY: 'k' }]) {
    const brevo = fakeBrevo(201);
    const db = fakeDb({ pending: [row(1)] });
    const counts = await sendDueEmails(db, { env, fetchImpl: brevo.fetchImpl });
    assert.deepEqual(counts, { enabled: true, sent: 0, failed: 0, skipped: 1, deferred: 0 });
    assert.equal(brevo.calls.length, 0);
    assert.equal([...db.records.values()][0].status, 'skipped');
  }
});

test('job step: stays under the daily limit', async () => {
  const brevo = fakeBrevo(201);
  const db = fakeDb({ pending: [row(1), row(2), row(3)], sentToday: 249 });
  const counts = await sendDueEmails(db, { env: ON, fetchImpl: brevo.fetchImpl });
  assert.equal(counts.sent, 1);
  assert.equal(counts.deferred, 2);
});

test('job step: stops when its time budget is used up', async () => {
  const brevo = fakeBrevo(201);
  const db = fakeDb({ pending: [row(1), row(2), row(3)] });
  let clock = 0;
  const now = () => { clock += 40000; return clock; };   // each check moves the clock 40 s
  const counts = await sendDueEmails(db, { env: ON, fetchImpl: brevo.fetchImpl, now, budgetMs: 60000 });
  assert.ok(counts.deferred >= 1);
  assert.equal(counts.sent + counts.deferred, 3);
});

test('job step: if the record cannot be updated, the email still counts as sent', async () => {
  const brevo = fakeBrevo(201);
  const db = fakeDb({ pending: [row(1)], failUpdate: true });
  const counts = await sendDueEmails(db, { env: ON, fetchImpl: brevo.fetchImpl });
  assert.equal(counts.sent, 1);
});

test('job step: nothing logged contains an address, the key or the reply', async () => {
  const lines = [];
  const original = console.warn;
  console.warn = (line) => lines.push(String(line));
  try {
    await sendDueEmails(fakeDb({ pending: [row(1)] }), { env: ON, fetchImpl: fakeBrevo(401).fetchImpl });
    await sendDueEmails(fakeDb({ pending: [row(2)], failUpdate: true }), { env: ON, fetchImpl: fakeBrevo(201).fetchImpl });
    await sendDueEmails(fakeDb({ pending: [row(3)] }), { env: { EMAIL_ENABLED: 'true' }, fetchImpl: fakeBrevo(201).fetchImpl });
  } finally {
    console.warn = original;
  }
  assert.ok(lines.length >= 3);
  for (const line of lines) {
    assert.ok(!line.includes('@'), line);
    assert.ok(!line.includes('test-key-not-real'), line);
  }
});
