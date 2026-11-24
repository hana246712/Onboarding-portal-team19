# Floci: plan events on Amazon SQS (Hana Anwar, #26)

On the live site (Vercel + Neon) the API writes "assigned" notifications itself, in the same database transaction as the change. In the AWS version, the API **sends plan events to an Amazon SQS queue** and a separate **notifier worker** turns them into notifications. The API and the notifier then share no database rights: the API can only send messages, the notifier can only read them and add notifications.

```
API (team19-api)  --SendMessage-->  team19-plan-events  --Receive/Delete-->  worker (team19-notifier)  --IAM login as notifier-->  RDS: notifications
                                          | after 3 failed tries
                                          v
                                   team19-plan-events-dlq
```

## What it builds (`setup-sqs.sh`, after `../setup.sh`)

| Part | Setting | Why |
|---|---|---|
| `team19-plan-events` | server-side encryption, long polling (20 s), visibility timeout 30 s, kept 4 days | events are private data at rest; fewer empty polls |
| Redrive policy | after **3** failed tries a message moves to `team19-plan-events-dlq` (kept 14 days) | a bad message is kept for inspection, not lost or retried forever |
| `team19-api` | may only `sqs:SendMessage` to this queue | a stolen API session can't read, delete or purge events |
| `team19-notifier` | may only receive, delete and change visibility on this queue | it can't inject fake events |
| `team19-dashboard`, `team19-db-admin` | no SQS rights | not needed |

The policies are `api-send-policy.json` and `notifier-consume-policy.json`, added as a second inline policy to the roles from `../setup.sh`.

## The app side

- `backend/src/lib/planEvents.js`: builds the events (ids only: no emails, names or note text). With `PLAN_EVENTS_QUEUE_URL` set, it sends them **after the database commit**, so a rolled-back change never sends anything. If the queue can't be reached, it writes the notifications directly instead: nothing is lost and the user's request still succeeds.
- `backend/src/lib/sqs.js`: AWS SDK v3 SQS client; credentials come from the role the code runs as, never from code.
- `backend/scripts/plan-events-worker.js`: reads the queue (`--once` for tests), accepts only valid plan events and only their own fields, saves the notification as the `notifier` database role, and deletes a message only after it is saved. SQS can deliver a message twice; saving twice adds nothing because of the once-per-day unique index.

## What the tests prove (`test-sqs.sh`)

1. **Queue settings**: encryption on both queues, dead-letter queue after 3 tries, long polling.
2. **Least privilege**, as each IAM role with Floci's IAM enforcement on: the API can send but not read, purge, delete or reconfigure the queue; the notifier can read but not send or purge; the dashboard and db-admin roles can do neither.
3. **End to end with the app's own code**: `planEvents.publish` sends as `team19-api`; the worker reads as `team19-notifier` and writes into RDS through an IAM database login as `notifier`; the notifications land for the right two people and the queue ends empty.
4. **Duplicates and bad messages**: the same events sent again add no notification; a message with an injected value saves nothing and ends in the dead-letter queue after 3 tries.

Results appear on the GitHub Actions run page (**Floci – plan events on SQS → Summary**) and as the `floci-sqs-results` artifact.

## Run it

**On GitHub:** every pull request that touches these files runs it; also **Actions → Floci – plan events on SQS → Run workflow**.

**On your laptop** (Docker Desktop, Git Bash, AWS CLI, `psql`, `jq`, Node 20, `npm install` in `backend/`): start Floci as in `../README.md`, then

```bash
bash infra/floci/setup.sh
bash infra/floci/sqs/setup-sqs.sh
bash infra/floci/sqs/test-sqs.sh
```

## Notes

- On real AWS the queue policy would also refuse requests without TLS (`aws:SecureTransport`); Floci listens on plain HTTP locally, so that condition is left out here.
- The test sets the visibility timeout to 1 s for the dead-letter check, then back to 30 s.
- If the worker is down, events wait in the queue (4 days) and are delivered when it comes back.
