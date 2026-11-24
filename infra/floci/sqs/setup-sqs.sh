#!/usr/bin/env bash
# =====================================================================
# Team 19 – Floci (AWS emulator): plan events on Amazon SQS
# Owner: Hana Anwar (issue #26)
#
# Run AFTER infra/floci/setup.sh (it creates the IAM roles this uses):
#   bash infra/floci/setup.sh
#   bash infra/floci/sqs/setup-sqs.sh
#   bash infra/floci/sqs/test-sqs.sh
#
# Builds:
#   1. team19-plan-events-dlq: dead-letter queue, keeps failed messages 14 days;
#   2. team19-plan-events: the queue the API sends plan events to;
#      server-side encryption on, long polling, and a redrive policy that
#      moves a message to the dead-letter queue after 3 failed tries;
#   3. least-privilege access, added to the existing roles:
#      team19-api may only SEND to the queue, team19-notifier may only
#      READ and DELETE from it; no other role gets any SQS permission.
# =====================================================================
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="${FLOCI_STATE_DIR:-$HERE/../.state}"
# shellcheck disable=SC1091
source "$STATE/env"   # ACCOUNT_ID, REGION, ... written by infra/floci/setup.sh

export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"   # Floci's bootstrap admin, build only
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_DEFAULT_REGION="$REGION"
export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:4566}"
export AWS_PAGER=""

QUEUE=team19-plan-events
DLQ=team19-plan-events-dlq
log() { printf '\n==> %s\n' "$*"; }

log "1/3 Dead-letter queue $DLQ"
DLQ_URL="$(aws sqs create-queue --queue-name "$DLQ" \
  --attributes SqsManagedSseEnabled=true,MessageRetentionPeriod=1209600 \
  --tags project=team19,owner=hana-anwar --query QueueUrl --output text)"
DLQ_ARN="$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)"
echo "  $DLQ_ARN"

log "2/3 Plan events queue $QUEUE"
REDRIVE="{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"3\"}"
ATTRS="$(jq -n --arg r "$REDRIVE" '{SqsManagedSseEnabled:"true", VisibilityTimeout:"30",
  ReceiveMessageWaitTimeSeconds:"20", MessageRetentionPeriod:"345600", RedrivePolicy:$r}')"
QUEUE_URL="$(aws sqs create-queue --queue-name "$QUEUE" --attributes "$ATTRS" \
  --tags project=team19,owner=hana-anwar --query QueueUrl --output text)"
# create-queue does not change an existing queue: set the attributes again
aws sqs set-queue-attributes --queue-url "$QUEUE_URL" --attributes "$ATTRS"
QUEUE_ARN="$(aws sqs get-queue-attributes --queue-url "$QUEUE_URL" --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)"
echo "  $QUEUE_ARN"

log "3/3 Least-privilege SQS access for the app roles"
render() { sed -e "s/\${ACCOUNT_ID}/$ACCOUNT_ID/g" -e "s/\${REGION}/$REGION/g" "$1"; }
aws iam put-role-policy --role-name team19-api --policy-name team19-plan-events-send \
  --policy-document "$(render "$HERE/api-send-policy.json")"
echo "  team19-api       <- api-send-policy.json (SendMessage on $QUEUE only)"
aws iam put-role-policy --role-name team19-notifier --policy-name team19-plan-events-consume \
  --policy-document "$(render "$HERE/notifier-consume-policy.json")"
echo "  team19-notifier  <- notifier-consume-policy.json (Receive/Delete on $QUEUE only)"

cat >> "$STATE/env" <<EOT
PLAN_EVENTS_QUEUE_URL=$QUEUE_URL
PLAN_EVENTS_QUEUE_ARN=$QUEUE_ARN
PLAN_EVENTS_DLQ_URL=$DLQ_URL
EOT

log "Done. Queue $QUEUE_URL"
