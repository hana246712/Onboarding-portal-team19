#!/usr/bin/env bash
# =====================================================================
# Team 19 – Floci tests for plan events on Amazon SQS
# Owner: Hana Anwar (issue #26)
#
# Run after infra/floci/setup.sh and setup-sqs.sh, against a Floci
# started with FLOCI_SERVICES_IAM_ENFORCEMENT_ENABLED=true.
# Every check is a real request made as one of our IAM roles.
#   1. queue settings (encryption, dead-letter queue, long polling)
#   2. who may send / read / delete / purge (least privilege)
#   3. end to end with the app's own code: the API code sends events as
#      team19-api, the worker reads them as team19-notifier and writes the
#      notifications into RDS with an IAM database login as `notifier`
#   4. a duplicate delivery adds nothing; a bad message ends in the
#      dead-letter queue instead of being lost or retried forever
# Writes infra/floci/.state/sqs-results.md and exits 1 if a check fails.
# =====================================================================
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
STATE="${FLOCI_STATE_DIR:-$HERE/../.state}"
# shellcheck disable=SC1091
source "$STATE/env"

export AWS_DEFAULT_REGION="$REGION"
export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:4566}"
export AWS_PAGER=""
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}" AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
Q="$PLAN_EVENTS_QUEUE_URL"

PASS=0; FAIL=0; SECTION=""
RESULTS="$STATE/sqs-results.md"
: > "$RESULTS.rows"
section() { SECTION="$1"; printf '\n## %s\n' "$1"; }
record() {  # ok|fail label detail
  local mark; if [ "$1" = ok ]; then PASS=$((PASS + 1)); mark=PASS; else FAIL=$((FAIL + 1)); mark=FAIL; fi
  local detail="${3//|/\\|}"; detail="${detail//$'\n'/ }"
  printf '%-5s %s%s\n' "$mark" "$2" "${3:+  ($3)}"
  printf '| %s | %s | %s | %s |\n' "$SECTION" "$mark" "$2" "${detail:0:160}" >> "$RESULTS.rows"
}
expect() {  # want(ok|refused) label pattern cmd...
  local want="$1" label="$2" pattern="$3"; shift 3
  local out rc; out="$("$@" 2>&1)"; rc=$?
  local got=ok; [ $rc -ne 0 ] && got=refused
  if [ "$got" = "$want" ] && { [ -z "$pattern" ] || grep -qiE "$pattern" <<<"$out"; }; then
    record ok "$label" "$(tail -n 1 <<<"$out" | cut -c1-120)"
  else
    record fail "$label" "expected $want, got $got: $(tail -n 2 <<<"$out" | tr '\n' ' ' | cut -c1-200)"
  fi
}
check() {  # label expected actual
  if [ "$2" = "$3" ]; then record ok "$1" "$3"; else record fail "$1" "expected $2, got $3"; fi
}

declare -A CREDS
as_role() {  # role cmd... — run with that role's temporary credentials only
  local role="$1"; shift
  if [ -z "${CREDS[$role]:-}" ]; then
    CREDS[$role]="$(aws sts assume-role --role-arn "arn:aws:iam::$ACCOUNT_ID:role/$role" \
      --role-session-name "sqs-test-$role" --duration-seconds 3600 --query Credentials --output json)"
  fi
  AWS_ACCESS_KEY_ID="$(jq -r .AccessKeyId <<<"${CREDS[$role]}")" \
  AWS_SECRET_ACCESS_KEY="$(jq -r .SecretAccessKey <<<"${CREDS[$role]}")" \
  AWS_SESSION_TOKEN="$(jq -r .SessionToken <<<"${CREDS[$role]}")" \
  "$@"
}
attr() { aws sqs get-queue-attributes --queue-url "$1" --attribute-names All --query "Attributes.$2" --output text; }
count_in() { attr "$1" ApproximateNumberOfMessages; }

MASTER_PASSWORD="$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --query SecretString --output text | jq -r .password)"
master_sql() {
  PGPASSWORD="$MASTER_PASSWORD" psql "host=$DB_HOST port=$DB_PORT dbname=$DB_NAME user=$MASTER_USER sslmode=prefer connect_timeout=10" \
    -v ON_ERROR_STOP=1 -tA -q -c "$1"
}
# The worker's database login: a 15-minute IAM token made by team19-notifier.
notifier_url() {
  local tok; tok="$(as_role team19-notifier aws rds generate-db-auth-token --hostname "$DB_HOST" \
    --port "$DB_PORT" --region "$REGION" --username notifier)" || return 1
  printf 'postgresql://notifier:%s@%s:%s/%s' "$(jq -rn --arg t "$tok" '$t|@uri')" "$DB_HOST" "$DB_PORT" "$DB_NAME"
}
run_worker_once() {  # prints the worker's one-line summary
  local url; url="$(notifier_url)" || return 1
  ( cd "$ROOT/backend" && as_role team19-notifier env PLAN_EVENTS_QUEUE_URL="$Q" NOTIFIER_DATABASE_URL="$url" \
      node scripts/plan-events-worker.js --once )
}
purge() { aws sqs purge-queue --queue-url "$1" >/dev/null 2>&1 || true; sleep 1; }

# ---------------------------------------------------------------------
section "1. Queue settings"
check "queue encrypted at rest (SSE)" "true" "$(attr "$Q" SqsManagedSseEnabled)"
REDRIVE="$(attr "$Q" RedrivePolicy)"
check "dead-letter queue after 3 tries" "3" "$(jq -r '.maxReceiveCount|tostring' <<<"$REDRIVE" 2>/dev/null)"
check "dead-letter queue is team19-plan-events-dlq" "team19-plan-events-dlq" "$(jq -r '.deadLetterTargetArn' <<<"$REDRIVE" 2>/dev/null | awk -F: '{print $NF}')"
check "dead-letter queue encrypted" "true" "$(attr "$PLAN_EVENTS_DLQ_URL" SqsManagedSseEnabled)"
check "long polling (20 s)" "20" "$(attr "$Q" ReceiveMessageWaitTimeSeconds)"

# ---------------------------------------------------------------------
section "2. Least privilege"
purge "$Q"
expect ok      "team19-api can send a plan event"            "MessageId" as_role team19-api aws sqs send-message --queue-url "$Q" --message-body '{"type":"plan.completed","planId":1,"customerId":1}'
expect refused "team19-api cannot read the queue"            "denied|not authori" as_role team19-api aws sqs receive-message --queue-url "$Q" --wait-time-seconds 1
expect refused "team19-api cannot purge the queue"           "denied|not authori" as_role team19-api aws sqs purge-queue --queue-url "$Q"
expect refused "team19-api cannot delete the queue"          "denied|not authori" as_role team19-api aws sqs delete-queue --queue-url "$Q"
expect refused "team19-api cannot change queue settings"     "denied|not authori" as_role team19-api aws sqs set-queue-attributes --queue-url "$Q" --attributes VisibilityTimeout=0
expect refused "team19-api cannot read the dead-letter queue" "denied|not authori" as_role team19-api aws sqs receive-message --queue-url "$PLAN_EVENTS_DLQ_URL" --wait-time-seconds 1
expect ok      "team19-notifier can read the queue"          "" as_role team19-notifier aws sqs receive-message --queue-url "$Q" --wait-time-seconds 1
expect refused "team19-notifier cannot send (no fake events)" "denied|not authori" as_role team19-notifier aws sqs send-message --queue-url "$Q" --message-body '{"type":"plan.completed","planId":1,"customerId":1}'
expect refused "team19-notifier cannot purge the queue"      "denied|not authori" as_role team19-notifier aws sqs purge-queue --queue-url "$Q"
expect refused "team19-dashboard cannot send"                "denied|not authori" as_role team19-dashboard aws sqs send-message --queue-url "$Q" --message-body x
expect refused "team19-dashboard cannot read"                "denied|not authori" as_role team19-dashboard aws sqs receive-message --queue-url "$Q" --wait-time-seconds 1
expect refused "team19-db-admin cannot read plan events"     "denied|not authori" as_role team19-db-admin aws sqs receive-message --queue-url "$Q" --wait-time-seconds 1
expect refused "team19-api cannot create queues"             "denied|not authori" as_role team19-api aws sqs create-queue --queue-name team19-rogue
purge "$Q"

# ---------------------------------------------------------------------
section "3. End to end with the app's code"
RUN="$(date +%s)"
SEED="$(master_sql "
WITH s AS (INSERT INTO users (name, email, password_hash, role) VALUES ('SQS Staff $RUN', 'sqs-staff-$RUN@example.test', 'x', 'Staff') RETURNING id),
     c AS (INSERT INTO users (name, email, password_hash, role) VALUES ('SQS Customer $RUN', 'sqs-cust-$RUN@example.test', 'x', 'Customer') RETURNING id),
     t AS (INSERT INTO templates (title) VALUES ('SQS test $RUN') RETURNING id),
     p AS (INSERT INTO onboarding_plans (template_id, template_version, customer_id, title, start_date, created_by)
           SELECT t.id, 1, c.id, 'SQS plan $RUN', CURRENT_DATE, s.id FROM t, c, s RETURNING id)
SELECT s.id || ' ' || c.id || ' ' || p.id FROM s, c, p")"
read -r STAFF_ID CUSTOMER_ID PLAN_ID <<<"$SEED"
if [ -z "${PLAN_ID:-}" ]; then
  record fail "test data in RDS" "could not create the test plan"
else
  record ok "test data in RDS" "plan $PLAN_ID, staff $STAFF_ID, customer $CUSTOMER_ID"

  # The API's own code (planEvents.publish) sends, signed as team19-api.
  PUBLISH_JS="const pe=require('./src/lib/planEvents');pe.publish([...pe.taskAssigned({planId:$PLAN_ID,assigneeIds:[$STAFF_ID,$CUSTOMER_ID]}),...pe.planCompleted({planId:$PLAN_ID,customerId:$CUSTOMER_ID})]).then(r=>console.log(JSON.stringify(r)),e=>{console.error(e.message);process.exit(1)})"
  OUT="$(cd "$ROOT/backend" && as_role team19-api env PLAN_EVENTS_QUEUE_URL="$Q" node -e "$PUBLISH_JS" 2>&1)"
  if grep -q '"sent":3' <<<"$OUT"; then record ok "API code (planEvents.publish) sent 3 events as team19-api" "$OUT"; else record fail "API code (planEvents.publish) sent 3 events as team19-api" "$OUT"; fi
  sleep 1

  # The worker reads them as team19-notifier and writes into RDS as `notifier` (IAM login).
  WORKED=""
  for i in 1 2 3; do
    W="$(run_worker_once 2>&1)"; echo "  worker: $W"
    grep -q '"received":[1-9]' <<<"$W" && WORKED="$WORKED $W"
    [ "$(count_in "$Q")" = "0" ] && [ -n "$WORKED" ] && break
    sleep 2
  done
  N="$(master_sql "SELECT count(*) FROM notifications WHERE plan_id = $PLAN_ID AND type = 'assigned' AND channel = 'in_app'")"
  check "worker saved 2 'assigned' notifications in RDS (as notifier, IAM login)" "2" "$N"
  check "queue is empty after the worker (messages deleted once saved)" "0" "$(count_in "$Q")"
  check "no message left in the dead-letter queue" "0" "$(count_in "$PLAN_EVENTS_DLQ_URL")"
  EMAILS="$(master_sql "SELECT count(*) FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.plan_id = $PLAN_ID AND u.id IN ($STAFF_ID, $CUSTOMER_ID)")"
  check "notifications went to the right two people" "2" "$EMAILS"

  # ---------------------------------------------------------------------
  section "4. Duplicates and bad messages"
  ( cd "$ROOT/backend" && as_role team19-api env PLAN_EVENTS_QUEUE_URL="$Q" node -e "$PUBLISH_JS" >/dev/null 2>&1 )
  sleep 1; run_worker_once >/dev/null 2>&1; run_worker_once >/dev/null 2>&1
  check "same events delivered again add no notification (at-least-once is safe)" "2" \
    "$(master_sql "SELECT count(*) FROM notifications WHERE plan_id = $PLAN_ID")"

  # A message that is not a plan event: never saved, never deleted, moved to the DLQ after 3 tries.
  aws sqs set-queue-attributes --queue-url "$Q" --attributes VisibilityTimeout=1   # speed up retries for the test
  as_role team19-api aws sqs send-message --queue-url "$Q" \
    --message-body "{\"type\":\"task.assigned\",\"planId\":\"$PLAN_ID; DROP TABLE users\",\"assigneeId\":1}" >/dev/null
  for i in 1 2 3 4 5 6; do run_worker_once >/dev/null 2>&1; sleep 2; [ "$(count_in "$PLAN_EVENTS_DLQ_URL")" != "0" ] && break; done
  aws sqs set-queue-attributes --queue-url "$Q" --attributes VisibilityTimeout=30
  check "bad message moved to the dead-letter queue after 3 tries" "1" "$(count_in "$PLAN_EVENTS_DLQ_URL")"
  check "bad message saved nothing" "2" "$(master_sql "SELECT count(*) FROM notifications WHERE plan_id = $PLAN_ID")"
  check "users table still there" "t" "$(master_sql "SELECT to_regclass('public.users') IS NOT NULL")"
  purge "$PLAN_EVENTS_DLQ_URL"

  master_sql "DELETE FROM onboarding_plans WHERE id = $PLAN_ID; DELETE FROM templates WHERE title = 'SQS test $RUN'; UPDATE users SET active = false WHERE id IN ($STAFF_ID, $CUSTOMER_ID);" >/dev/null
fi

# ---------------------------------------------------------------------
{
  echo "# Floci – plan events on SQS (issue #26)"
  echo
  echo "**$PASS passed, $FAIL failed.** Every check is a real request as one of the IAM roles, with Floci's IAM policy enforcement on."
  echo
  echo "| Section | Result | Check | Detail |"
  echo "|---|---|---|---|"
  cat "$RESULTS.rows"
} > "$RESULTS"
rm -f "$RESULTS.rows"
printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
