import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { SQSClient } from '@aws-sdk/client-sqs';

export const banco = new DataSource({ type: 'postgres', url: process.env.DATABASE_URL ?? 'postgres://jungle:jungle@localhost:5432/jungle', synchronize: false, entities: [] });
export const sqs = new SQSClient({ region: process.env.AWS_REGION ?? 'us-east-1', endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566', credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' } });
export const queueUrl = process.env.SQS_QUEUE_URL ?? 'http://localhost:4566/000000000000/wager-transactions.fifo';

/** JSON canônico: recursivo, ordenado alfabeticamente e sem metadados HTTP. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value as object).filter(k => (value as Record<string, unknown>)[k] !== undefined).sort().map(k => JSON.stringify(k)+':'+canonical((value as Record<string, unknown>)[k])).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const id = () => crypto.randomUUID();
export function log(event: string, ctx: Record<string, unknown> = {}) {
  const safeKeys = ['correlationId','messageId','transactionId','walletId','providerId','status','code','attempt','eventId','durationMs'];
  const safe = Object.fromEntries(Object.entries(ctx).filter(([k]) => safeKeys.includes(k)));
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...safe }));
}
export const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

export const eventsQueueUrl = process.env.SQS_EVENTS_QUEUE_URL ?? 'http://localhost:4566/000000000000/wager-events.fifo';
