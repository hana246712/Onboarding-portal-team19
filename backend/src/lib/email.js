// Email for the daily notification job, sent through Brevo's transactional
// email API (POST https://api.brevo.com/v3/smtp/email).
//
// - Sends only when EMAIL_ENABLED=true. The key comes only from BREVO_API_KEY
//   and the sender only from EMAIL_FROM (Vercel environment variables).
// - The message holds the task title, plan title, due date and a link to the
//   plan, as plain text (no HTML, so a task title can't become markup).
// - At most one email per person, task and day: the email is first recorded
//   in notifications (channel 'email'), whose once-per-day unique index stops
//   any second send; then the result is stored in delivery_status.
// - Fails soft: a missing key, a Brevo error or a 5-second timeout never
//   throws; the in-app notifications are already saved by then.
// - Never logs an email address, the key or Brevo's reply body.

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const SITE_URL = 'https://team19-web.vercel.app';
const SENDER_NAME = 'Team 19 Onboarding Portal';
const TIMEOUT_MS = 5000;           // per email
const RUN_BUDGET_MS = 60000;       // whole email step, far below Vercel's 300 s limit
const MAX_FAILURES_IN_A_ROW = 3;   // Brevo down or key wrong: stop instead of trying every email
const DAILY_LIMIT = 250;           // Brevo's free plan allows 300 a day; leaves room for manual tests

function emailSettings(env = process.env) {
  return {
    enabled: env.EMAIL_ENABLED === 'true',
    apiKey: env.BREVO_API_KEY || '',
    from: env.EMAIL_FROM || '',
  };
}

// One line, no control characters, limited length (titles are typed by users).
function clean(text, max) {
  return String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

function planLink(planId) {
  return `${SITE_URL}/plans.html?id=${encodeURIComponent(String(planId))}`;
}

// The whole message: task title, plan title, due date and a link. Nothing else.
function buildDueEmail({ taskTitle, planTitle, dueDate, planId }) {
  const task = clean(taskTitle, 200);
  return {
    subject: clean(`Overdue task: ${task}`, 150),
    text: [
      'Hello,',
      '',
      'A task you own in the Onboarding Portal is overdue.',
      '',
      `Task: ${task}`,
      `Plan: ${clean(planTitle, 150)}`,
      `Due date: ${clean(dueDate, 10)}`,
      '',
      `Open the plan: ${planLink(planId)}`,
      '',
      'You get at most one email per task per day.',
    ].join('\n'),
  };
}

// Sends one email. Returns { ok: true } or { ok: false, status } and never throws.
// Brevo's reply body is never read, so it can't end up in a log.
async function sendEmail({ to, subject, text }, { apiKey, from, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS }) {
  try {
    const res = await fetchImpl(BREVO_URL, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: SENDER_NAME, email: from },
        to: [{ email: to }],
        subject,
        textContent: text,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? { ok: true } : { ok: false, status: res.status };
  } catch (err) {
    return { ok: false, status: err && err.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

function remainingToday(sentToday, limit = DAILY_LIMIT) {
  return Math.max(0, Math.min(limit, 300) - sentToday);
}

// Today's overdue notices for task owners that have no email record yet.
// The person must still own the task now (same rule as the job: staff task ->
// assignee, customer task -> the plan's customer), so a task reassigned after
// today's notice is never emailed to its old owner.
// A Customer never gets the title of an internal task (the schema already
// forbids a customer owner for one; this keeps it true if that rule changes).
const PENDING_SQL = `
  SELECT n.user_id, n.plan_id, n.task_id, n.type, u.email,
         t.title AS task_title, p.title AS plan_title,
         to_char(t.due_date, 'YYYY-MM-DD') AS due_date
    FROM notifications n
    JOIN users u            ON u.id = n.user_id
    JOIN tasks t            ON t.id = n.task_id
    JOIN onboarding_plans p ON p.id = n.plan_id
   WHERE n.channel = 'in_app' AND n.type = 'overdue' AND n.notify_date = CURRENT_DATE
     AND u.active AND p.status = 'Active' AND t.status <> 'Done'
     AND u.id = CASE WHEN t.actor = 'customer' THEN p.customer_id ELSE t.assignee_id END
     AND NOT (u.role = 'Customer' AND t.visibility = 'internal')
     AND NOT EXISTS (
           SELECT 1 FROM notifications e
            WHERE e.channel = 'email' AND e.user_id = n.user_id AND e.plan_id = n.plan_id
              AND e.task_id = n.task_id AND e.type = n.type AND e.notify_date = CURRENT_DATE)
   ORDER BY t.due_date, n.id`;

// Sends the day's emails with the notifier database role.
// Returns counts only: { enabled, sent, failed, skipped, deferred }.
//   skipped  = recorded but not sent, because BREVO_API_KEY or EMAIL_FROM is missing
//   deferred = left for the next run (daily limit, time budget or Brevo failing)
async function sendDueEmails(db, options = {}) {
  const {
    env = process.env,
    fetchImpl = globalThis.fetch,
    timeoutMs = TIMEOUT_MS,
    budgetMs = RUN_BUDGET_MS,
    limit = DAILY_LIMIT,
    now = Date.now,
  } = options;
  const counts = { enabled: false, sent: 0, failed: 0, skipped: 0, deferred: 0 };
  const settings = emailSettings(env);
  if (!settings.enabled) return counts;
  counts.enabled = true;
  const configured = Boolean(settings.apiKey && settings.from);

  const sentToday = (await db.query(
    `SELECT COUNT(*)::int AS n FROM notifications
      WHERE channel = 'email' AND notify_date = CURRENT_DATE AND delivery_status = 'sent'`
  )).rows[0].n;
  const room = remainingToday(sentToday, limit);
  const { rows } = await db.query(PENDING_SQL);

  const started = now();
  let failuresInARow = 0;
  let lastFailure = null;
  for (let i = 0; i < rows.length; i += 1) {
    if (i >= room || failuresInARow >= MAX_FAILURES_IN_A_ROW || now() - started > budgetMs) {
      counts.deferred = rows.length - i;
      break;
    }
    const r = rows[i];
    // Record first: if this row already exists (another run), nothing is sent.
    // Stored as 'failed' until Brevo confirms, so a crash never shows 'sent'.
    const claim = await db.query(
      `INSERT INTO notifications (user_id, plan_id, task_id, type, channel, delivery_status)
       VALUES ($1, $2, $3, $4, 'email', $5)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [r.user_id, r.plan_id, r.task_id, r.type, configured ? 'failed' : 'skipped']
    );
    if (!claim.rows[0]) continue;
    if (!configured) {
      counts.skipped += 1;
      continue;
    }

    const message = buildDueEmail({ taskTitle: r.task_title, planTitle: r.plan_title, dueDate: r.due_date, planId: r.plan_id });
    const result = await sendEmail(
      { to: r.email, ...message },
      { apiKey: settings.apiKey, from: settings.from, fetchImpl, timeoutMs }
    );
    if (!result.ok) {
      counts.failed += 1;
      failuresInARow += 1;
      lastFailure = result.status;
      continue;
    }
    counts.sent += 1;
    failuresInARow = 0;
    try {
      await db.query(`UPDATE notifications SET delivery_status = 'sent' WHERE id = $1`, [claim.rows[0].id]);
    } catch (err) {
      // The email went out; only the record could not be updated (for example a missing grant).
      console.warn(JSON.stringify({ level: 'warn', message: 'Email sent but its record could not be updated', code: err.code }));
    }
  }

  if (!configured && counts.skipped > 0) {
    console.warn(JSON.stringify({ level: 'warn', message: 'EMAIL_ENABLED is true but BREVO_API_KEY or EMAIL_FROM is not set; no email sent' }));
  }
  if (counts.failed > 0) {
    console.warn(JSON.stringify({ level: 'warn', message: 'Some emails could not be sent', failed: counts.failed, lastStatus: lastFailure }));
  }
  return counts;
}

module.exports = {
  BREVO_URL,
  DAILY_LIMIT,
  emailSettings,
  buildDueEmail,
  sendEmail,
  remainingToday,
  sendDueEmails,
};
