import { CreateQueueCommand } from '@aws-sdk/client-sqs';
import { sqs } from '../src/infrastructure/common';
const prefix = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
const dlq = await sqs.send(new CreateQueueCommand({QueueName:'wager-transactions-dlq.fifo', Attributes:{FifoQueue:'true',ContentBasedDeduplication:'false'}}));
const arn = `arn:aws:sqs:us-east-1:000000000000:wager-transactions-dlq.fifo`;
await sqs.send(new CreateQueueCommand({QueueName:'wager-transactions.fifo',Attributes:{FifoQueue:'true',ContentBasedDeduplication:'false',VisibilityTimeout:'30',RedrivePolicy:JSON.stringify({deadLetterTargetArn:arn,maxReceiveCount:5})}}));
await sqs.send(new CreateQueueCommand({QueueName:'wager-events.fifo',Attributes:{FifoQueue:'true',ContentBasedDeduplication:'false'}}));
console.log('Filas prontas', prefix, dlq.QueueUrl);
