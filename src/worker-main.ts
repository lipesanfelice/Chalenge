import 'reflect-metadata';
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { banco,sqs,queueUrl,eventsQueueUrl,log,pause } from './infrastructure/common';
import { WagerService } from './services/wager.service';
import { DomainError } from './domain/money';

let running=true;
process.on('SIGTERM',()=>{running=false;});
process.on('SIGINT',()=>{running=false;});
await banco.initialize();
const service=new WagerService();
const consumerName='wager-consumer';

async function consume() {
  const received=await sqs.send(new ReceiveMessageCommand({QueueUrl:queueUrl,MaxNumberOfMessages:10,
    WaitTimeSeconds:3,AttributeNames:['ApproximateReceiveCount']}));
  for(const message of received.Messages??[]) {
    if (!message.Body || !message.MessageId || !message.ReceiptHandle) continue;
    try {
      const envelope=JSON.parse(message.Body);
      if(envelope.type!=='WagerTransactionRequested'||!envelope.data) throw new DomainError('INVALID_MESSAGE_TYPE');
      const {idempotencyKey, ...data}=envelope.data;
      const outcome=await service.execute(data,idempotencyKey,
        {name:consumerName,messageId:envelope.messageId??message.MessageId});
      await sqs.send(new DeleteMessageCommand({QueueUrl:queueUrl,ReceiptHandle:message.ReceiptHandle}));
      log('message_acked',{messageId:message.MessageId,transactionId:outcome.transactionId,status:outcome.status});
    } catch(e) {
      // Erro de domínio permanente: a mensagem não melhora com repetição.
      if(e instanceof DomainError) {
        log('message_rejected',{messageId:message.MessageId,code:e.code});
        await sqs.send(new DeleteMessageCommand({QueueUrl:queueUrl,ReceiptHandle:message.ReceiptHandle}));
      } else {
        // Sem ACK: SQS disponibilizará a mensagem após visibility timeout;
        // redrive policy aplica maxReceiveCount=5 e move para a DLQ.
        log('message_retry',{messageId:message.MessageId,attempt:Number(message.Attributes?.ApproximateReceiveCount??1)});
      }
    }
  }
}

async function publishOutbox() {
  const q=banco.createQueryRunner(); await q.connect();
  try {
    await q.startTransaction();
    const items=await q.query(`SELECT * FROM outbox_messages WHERE published_at IS NULL AND next_attempt_at<=now()
       ORDER BY occurred_at LIMIT 20 FOR UPDATE SKIP LOCKED`);
    for(const item of items) {
      try {
        await sqs.send(new SendMessageCommand({QueueUrl:eventsQueueUrl,MessageBody:JSON.stringify(item.payload),
          MessageGroupId:item.aggregate_id,MessageDeduplicationId:item.id}));
        await q.query('UPDATE outbox_messages SET published_at=now() WHERE id=$1',[item.id]);
      } catch {
        await q.query(`UPDATE outbox_messages SET attempts=attempts+1,
          next_attempt_at=now()+(LEAST(300,POWER(2,LEAST(attempts+1,8)))::text || ' seconds')::interval
          WHERE id=$1`,[item.id]);
      }
    }
    await q.commitTransaction();
  } catch(e) { if(q.isTransactionActive) await q.rollbackTransaction(); throw e; }
  finally { await q.release(); }
}

// Workers de outbox concorrentes se dividem por SKIP LOCKED (sem lock global).
// O broker é at-least-once: consumidor externo precisa deduplicar por eventId.
let lastRetry=0;
while(running) {
  try {
    await publishOutbox();
    if(Date.now()-lastRetry>5000) { await service.retryReferences();lastRetry=Date.now(); }
    await consume();
  } catch { log('worker_transient_failure'); await pause(2000); }
}
await banco.destroy();
console.log(JSON.stringify({event:'worker_shutdown'}));
