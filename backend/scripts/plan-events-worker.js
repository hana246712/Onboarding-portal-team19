// Plan events worker - Owner: Hana Anwar (issue #26).
// The notifier side of the AWS version (Floci): reads plan events from the
// Amazon SQS queue and writes the in-app notifications.
//
//   node scripts/plan-events-worker.js          keep polling (a long-running worker)
//   node scripts/plan-events-worker.js --once   read the queue once, then exit (used by the tests)
//
// Needs: PLAN_EVENTS_QUEUE_URL and NOTIFIER_DATABASE_URL (the notifier role,
// which may only read plans/tasks and add notifications). AWS credentials come
// from the standard chain (on AWS: the role of the service it runs in; in the
// Floci tests: the team19-notifier role).
//
// Delivery rules:
//   - a message is deleted only after its notification is saved;
//   - a message that is not a valid plan event is NOT deleted: after 3 tries
//     SQS moves it to the dead-letter queue, where it can be inspected;
//   - SQS may deliver a message twice; saving twice is harmless because of
//     the once-per-day unique index (ON CONFLICT DO NOTHING).
// It logs ids and counts only, never message bodies.

const path = require('node:path');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  // no .env file: settings come from the environment
}

const planEvents = require('../src/lib/planEvents');
const sqs = require('../src/lib/sqs');
const pool = require('../src/db/pool');

const once = process.argv.includes('--once');
const queueUrl = process.env.PLAN_EVENTS_QUEUE_URL;
if (!queueUrl) {
  console.error('PLAN_EVENTS_QUEUE_URL is not set.');
  process.exit(1);
}

async function handle(message) {
  const event = planEvents.parseEvent(message.Body);
  if (!event) {
    console.warn(`message ${message.MessageId}: not a valid plan event; left for the dead-letter queue`);
    return 'invalid';
  }
  await planEvents.storeNotifications(pool.notifierDb(), [event]);
  await sqs.remove(queueUrl, message.ReceiptHandle);
  return event.type;
}

async function pollOnce(waitSeconds) {
  const counts = {};
  const messages = await sqs.receive(queueUrl, waitSeconds);
  for (const m of messages) {
    let result;
    try {
      result = await handle(m);
    } catch (err) {
      // Not deleted: SQS makes it visible again and retries it.
      console.error(`message ${m.MessageId}: failed (${err.code || err.name}); will be retried`);
      result = 'failed';
    }
    counts[result] = (counts[result] || 0) + 1;
  }
  return { received: messages.length, ...counts };
}

async function main() {
  if (once) {
    const summary = await pollOnce(2);
    console.log(JSON.stringify(summary));
    return summary.failed ? 1 : 0;
  }
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  console.log('Plan events worker started.');
  while (!stopping) {
    try {
      const summary = await pollOnce(20);
      if (summary.received) console.log(JSON.stringify(summary));
    } catch (err) {
      console.error(`receive failed (${err.name}); retrying in 5 s`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  return 0;
}

main()
  .then(async (status) => {
    await pool.notifierDb().end().catch(() => {});
    process.exit(status);
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
