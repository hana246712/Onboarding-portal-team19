// Amazon SQS client for plan events - Owner: Hana Anwar (issue #26).
// Used only when PLAN_EVENTS_QUEUE_URL is set (the AWS version on Floci).
//
// Credentials come from the standard AWS chain: on AWS, the role of the
// service the code runs in (ECS task role / Lambda execution role); in the
// Floci tests, the IAM role assumed for that part of the app. Nothing is
// stored in code. AWS_ENDPOINT_URL points the client at Floci; on real AWS
// it is left unset.

const {
  SQSClient,
  SendMessageBatchCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} = require('@aws-sdk/client-sqs');

let client;
function sqs() {
  if (!client) {
    client = new SQSClient({
      region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
      ...(process.env.AWS_ENDPOINT_URL ? { endpoint: process.env.AWS_ENDPOINT_URL } : {}),
      maxAttempts: 3,
    });
  }
  return client;
}

// Sends events in batches of 10 (the SQS limit). Throws if any message failed,
// so the caller can fall back to writing notifications directly.
async function sendEvents(queueUrl, events) {
  for (let i = 0; i < events.length; i += 10) {
    const batch = events.slice(i, i + 10);
    const res = await sqs().send(new SendMessageBatchCommand({
      QueueUrl: queueUrl,
      Entries: batch.map((e, n) => ({
        Id: String(n),
        MessageBody: JSON.stringify(e),
        MessageAttributes: { eventType: { DataType: 'String', StringValue: e.type } },
      })),
    }));
    if (res.Failed && res.Failed.length) {
      const err = new Error(`${res.Failed.length} plan event(s) were not accepted by the queue`);
      err.name = 'SqsBatchFailed';
      throw err;
    }
  }
}

// Long-polls for up to 10 messages.
async function receive(queueUrl, waitSeconds = 20) {
  const res = await sqs().send(new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: waitSeconds,
  }));
  return res.Messages || [];
}

async function remove(queueUrl, receiptHandle) {
  await sqs().send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
}

module.exports = { sendEvents, receive, remove };
