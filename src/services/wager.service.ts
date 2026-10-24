import { Injectable } from '@nestjs/common';
import type { QueryRunner } from 'typeorm';
import { banco, hash, id, canonical, log } from '../infrastructure/common';
import { DomainError, Money, type MoneyProps } from '../domain/money';
import { type Kind, type Direction, WalletLedgerEntry, Wallet } from '../domain/models';
import { WagerTransactionProcessed, WagerTransactionRejected, WagerTransactionPendingReference, WalletBalanceChanged } from '../domain/events';

export type WagerInput = {
  providerId: string; externalTransactionId: string; playerId: string; walletId: string;
  roundId: string; gameId: string; kind: Exclude<Kind, 'OPENING'>; money: MoneyProps;
  referenceExternalTransactionId?: string;
};
export type Result = { transactionId: string; status: string; balance: MoneyProps | null; idempotentReplay: boolean; failureCode?: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tipos = ['BET','WIN','LOSS','REFUND','ROLLBACK'];
const text = (x: unknown) => typeof x === 'string' && x.length > 0 && x.length <= 150;
const objMoney = (amount: string, currency: string): MoneyProps => Money.from({amount,currency},true).toJSON();
export function validateInput(v: WagerInput): Money {
  if (!v || !text(v.providerId) || !text(v.externalTransactionId) || !text(v.roundId) || !text(v.gameId) ||
    !uuid.test(v.walletId) || !uuid.test(v.playerId) || !tipos.includes(v.kind)) throw new DomainError('INVALID_PAYLOAD');
  if (v.referenceExternalTransactionId !== undefined && !text(v.referenceExternalTransactionId)) throw new DomainError('INVALID_PAYLOAD');
  if (['REFUND','ROLLBACK'].includes(v.kind) && !text(v.referenceExternalTransactionId)) throw new DomainError('REFERENCE_REQUIRED');
  const m = Money.from(v.money);
  if (m.isZero()) throw new DomainError('INVALID_MONEY');
  return m;
}
const formatResult = (r: any, replay = false): Result => ({
  transactionId: r.id, status: r.status,
  balance: r.result_balance === null ? null : objMoney(r.result_balance, r.currency),
  idempotentReplay: replay, ...(r.failure_code ? {failureCode:r.failure_code}: {})
});

/** Grava um evento na outbox ainda DENTRO da transação financeira. */
async function event(q: QueryRunner, type: string, aggregateId: string, correlationId: string, data: object) {
  const eventId = id();
  const props = {eventId,aggregateId,correlationId,occurredAt:new Date(),data};
  const payload = type === 'WagerTransactionProcessed' ? WagerTransactionProcessed.from(props as any).toJSON() :
    type === 'WagerTransactionRejected' ? WagerTransactionRejected.from(props as any).toJSON() :
    type === 'WagerTransactionPendingReference' ? WagerTransactionPendingReference.from(props as any).toJSON() :
    WalletBalanceChanged.from(props as any).toJSON();
  await q.query('INSERT INTO outbox_messages(id,aggregate_id,event_type,payload) VALUES ($1,$2,$3,$4)',
    [eventId,aggregateId,type,JSON.stringify(payload)]);
}

@Injectable()
export class WagerService {
  /** Inbox é opcional para HTTP e obrigatório para SQS, sem duplicar lógica. */
  async execute(input: WagerInput, key: string, inbox?: {name:string;messageId:string}): Promise<Result> {
    const amount = validateInput(input);
    if (!text(key) || key.length > 255) throw new DomainError('INVALID_IDEMPOTENCY_KEY');
    const payloadHash = hash(input);
    const q = banco.createQueryRunner();
    await q.connect();
    try {
      await q.startTransaction();
      const transactionId = id();
      // Unique indexes arbitram a idempotência até entre processos diferentes.
      await q.query(`INSERT INTO wager_transactions
        (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,
         round_id,game_id,kind,amount,currency,reference_external_transaction_id,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'PENDING')
        ON CONFLICT DO NOTHING`,[transactionId,input.providerId,input.externalTransactionId,key,payloadHash,
        input.walletId,input.playerId,input.roundId,input.gameId,input.kind,amount.toString(),amount.currency,
        input.referenceExternalTransactionId ?? null]);
      // Ordem: lock da própria transação -> lock da wallet -> ledger -> outbox.
      const [tx] = await q.query(`SELECT * FROM wager_transactions WHERE idempotency_key=$1 OR
        (provider_id=$2 AND external_transaction_id=$3) ORDER BY (idempotency_key=$1) DESC LIMIT 1 FOR UPDATE`,
        [key,input.providerId,input.externalTransactionId]);
      if (!tx) throw new DomainError('TRANSACTION_NOT_FOUND');
      if (tx.idempotency_key !== key || tx.payload_hash !== payloadHash) throw new DomainError('IDEMPOTENCY_CONFLICT');
      if (inbox) {
        const messageHash = hash({key,input});
        const seen = await q.query(`INSERT INTO inbox_messages(consumer_name,message_id,payload_hash)
           VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING message_id`,[inbox.name,inbox.messageId,messageHash]);
        if (!seen.length) {
          const [old] = await q.query('SELECT payload_hash FROM inbox_messages WHERE consumer_name=$1 AND message_id=$2',[inbox.name,inbox.messageId]);
          if (old?.payload_hash !== messageHash) throw new DomainError('INBOX_MESSAGE_CONFLICT');
        }
      }
      if (['PROCESSED','REJECTED','FAILED'].includes(tx.status)) {
        await q.commitTransaction(); return formatResult(tx,true);
      }
      // Locks por wallet: transações de wallets diferentes continuam em paralelo.
      const [w] = await q.query('SELECT * FROM wallets WHERE id=$1 FOR UPDATE',[input.walletId]);
      if (!w) throw new DomainError('WALLET_NOT_FOUND');
      if (w.player_id !== input.playerId || w.currency !== amount.currency) throw new DomainError('WALLET_MISMATCH');
      const wallet = Wallet.rehydrate({id:w.id,playerId:w.player_id,balance:Money.from({amount:w.balance,currency:w.currency}),
        version:w.version,createdAt:w.created_at,updatedAt:w.updated_at});
      let ref: any;
      let failure: string | undefined;
      let direction: Direction | undefined;
      if (input.kind === 'REFUND' || input.kind === 'ROLLBACK') {
        const [reference] = await q.query(`SELECT * FROM wager_transactions
          WHERE provider_id=$1 AND external_transaction_id=$2`,[input.providerId,input.referenceExternalTransactionId]);
        ref = reference;
        if (!ref || !['PROCESSED','REJECTED','FAILED'].includes(ref.status)) {
          const attempt = tx.attempts + 1;
          if (attempt >= 8) failure='REFERENCE_NOT_FOUND';
          else {
            await q.query(`UPDATE wager_transactions SET status='PENDING_REFERENCE', attempts=$2,
              next_attempt_at=now()+($3 || ' seconds')::interval WHERE id=$1`,
              [tx.id,attempt,String(Math.min(300,2**attempt))]);
            if (tx.status !== 'PENDING_REFERENCE') await event(q,'WagerTransactionPendingReference',w.id,tx.id,{transactionId:tx.id});
            await q.commitTransaction();
            return {transactionId:tx.id,status:'PENDING_REFERENCE',balance:null,idempotentReplay:false};
          }
        } else if (ref.status !== 'PROCESSED') failure='REFERENCE_NOT_PROCESSED';
        else if (ref.provider_id!==input.providerId || ref.player_id!==input.playerId || ref.wallet_id!==input.walletId ||
          ref.round_id!==input.roundId || ref.currency!==amount.currency) failure='REFERENCE_MISMATCH';
        else if ((input.kind==='REFUND' && ref.kind!=='BET') ||
          (input.kind==='ROLLBACK' && !['BET','WIN','REFUND'].includes(ref.kind))) failure='INVALID_REFERENCE_KIND';
        else if (ref.amount!==amount.toString()) failure='REFERENCE_AMOUNT_MISMATCH';
        else {
          const [prior] = await q.query(`SELECT id FROM wager_transactions WHERE reference_transaction_id=$1
             AND kind=$2 AND status='PROCESSED' LIMIT 1`,[ref.id,input.kind]);
          if (prior) failure='ALREADY_REVERSED';
          else direction = input.kind==='REFUND' ? 'CREDIT' : (ref.kind==='BET' ? 'CREDIT' : 'DEBIT');
        }
      } else direction = input.kind==='BET'?'DEBIT':input.kind==='WIN'?'CREDIT':undefined;
      const before=wallet.balance;
      let after=before;
      if (!failure && direction) {
        try { after = wallet.apply(amount,direction).after; }
        catch(e) {
          if (e instanceof DomainError && e.code==='INSUFFICIENT_FUNDS') failure = input.kind==='BET'?'INSUFFICIENT_FUNDS':'REVERSAL_INSUFFICIENT_FUNDS';
          else throw e;
        }
      }
      if (failure) {
        await q.query(`UPDATE wager_transactions SET status='REJECTED',failure_code=$2,result_balance=$3,processed_at=now()
          WHERE id=$1`,[tx.id,failure,before.toString()]);
        await event(q,'WagerTransactionRejected',w.id,tx.id,{transactionId:tx.id,code:failure});
        await q.commitTransaction();
        return {transactionId:tx.id,status:'REJECTED',balance:before.toJSON(),failureCode:failure,idempotentReplay:false};
      }
      if (direction) {
        WalletLedgerEntry.create(w.id,tx.id,direction,amount,before,after);
        // Trigger SQL também verifica a aritmética e atualiza a wallet de forma atômica.
        await q.query(`INSERT INTO wallet_ledger(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id(),w.id,tx.id,direction,amount.toString(),amount.currency,before.toString(),after.toString()]);
        await event(q,'WalletBalanceChanged',w.id,tx.id,{walletId:w.id,transactionId:tx.id,direction,money:amount.toJSON(),
          balanceBefore:before.toJSON(),balanceAfter:after.toJSON(),walletVersion:wallet.version});
      }
      await q.query(`UPDATE wager_transactions SET status='PROCESSED',reference_transaction_id=$2,
        result_balance=$3,processed_at=now() WHERE id=$1`,[tx.id,ref?.id??null,after.toString()]);
      await event(q,'WagerTransactionProcessed',w.id,tx.id,{transactionId:tx.id,kind:input.kind});
      await q.commitTransaction();
      log('transaction_processed',{transactionId:tx.id,walletId:w.id,providerId:input.providerId,status:'PROCESSED'});
      return {transactionId:tx.id,status:'PROCESSED',balance:after.toJSON(),idempotentReplay:false};
    } catch(e) { if(q.isTransactionActive) await q.rollbackTransaction(); throw e; }
    finally { await q.release(); }
  }

  /** Reprocessamento usa o mesmo caso de uso: mesmo hash, mesma key. */
  async retryReferences() {
    const rows = await banco.query(`SELECT * FROM wager_transactions WHERE status='PENDING_REFERENCE'
      AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT 40`);
    for (const t of rows) {
      try { await this.execute({providerId:t.provider_id,externalTransactionId:t.external_transaction_id,
        walletId:t.wallet_id,playerId:t.player_id,roundId:t.round_id,gameId:t.game_id,
        kind:t.kind,money:{amount:t.amount,currency:t.currency},
        referenceExternalTransactionId:t.reference_external_transaction_id},t.idempotency_key); }
      catch(e) { log('retry_failed',{transactionId:t.id,code:e instanceof DomainError?e.code:'TRANSIENT_FAILURE'}); }
    }
  }
}
