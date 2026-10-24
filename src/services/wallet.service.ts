import { Injectable } from '@nestjs/common';
import { banco, id } from '../infrastructure/common';
import { DomainError, Money, type MoneyProps } from '../domain/money';

const validUUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toMoney=(amount:string,currency:string):MoneyProps=>Money.from({amount,currency}).toJSON();
@Injectable()
export class WalletService {
  async create(playerId:string, initialBalance:MoneyProps) {
    if (!validUUID.test(playerId)) throw new DomainError('INVALID_PLAYER_ID');
    const amount=Money.from(initialBalance);
    const walletId=id(), transactionId=id();
    const q=banco.createQueryRunner(); await q.connect();
    try {
      await q.startTransaction();
      // Cria wallet zerada. Crédito de abertura passa pelo mesmo trigger do ledger.
      await q.query(`INSERT INTO wallets(id,player_id,currency,balance,version) VALUES($1,$2,$3,0,1)`,
        [walletId,playerId,amount.currency]);
      if (!amount.isZero()) {
        await q.query(`INSERT INTO wager_transactions(id,provider_id,external_transaction_id,idempotency_key,
          payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,result_balance,processed_at)
          VALUES($1,'__internal__',$2,$3,repeat('0',64),$4,$5,'__opening__','__opening__',
            'OPENING',$6,$7,'PROCESSED',$6,now())`,
          [transactionId,transactionId,`opening:${walletId}`,walletId,playerId,amount.toString(),amount.currency]);
        await q.query(`INSERT INTO wallet_ledger(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after)
          VALUES($1,$2,$3,'CREDIT',$4,$5,'0.00',$4)`,[id(),walletId,transactionId,amount.toString(),amount.currency]);
        const eventId=id();
        await q.query(`INSERT INTO outbox_messages(id,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4)`,
          [eventId,walletId,'WalletBalanceChanged',JSON.stringify({eventId,eventType:'WalletBalanceChanged',version:1,
            aggregateId:walletId,correlationId:transactionId,occurredAt:new Date().toISOString(),
            data:{walletId,transactionId,direction:'CREDIT',money:amount.toJSON(),balanceBefore:Money.zero(amount.currency).toJSON(),
              balanceAfter:amount.toJSON(),walletVersion:1}})]);
      }
      await q.commitTransaction();
      return {id:walletId,playerId,balance:amount.toJSON(),version:1};
    } catch(e:any) { if(q.isTransactionActive) await q.rollbackTransaction();
      if(e.code==='23505') throw new DomainError('WALLET_ALREADY_EXISTS'); throw e;
    } finally { await q.release(); }
  }
  async get(walletId:string) {
    if (!validUUID.test(walletId)) throw new DomainError('INVALID_WALLET_ID');
    const [w]=await banco.query('SELECT * FROM wallets WHERE id=$1',[walletId]);
    if (!w) throw new DomainError('WALLET_NOT_FOUND');
    return {id:w.id,playerId:w.player_id,balance:toMoney(w.balance,w.currency),version:w.version};
  }
  async ledger(walletId:string,cursor?:string,limit=50) {
    if (!validUUID.test(walletId)) throw new DomainError('INVALID_WALLET_ID');
    if (!Number.isInteger(limit)||limit<1||limit>100) throw new DomainError('INVALID_LIMIT');
    let anchor:[string,string]|undefined;
    if (cursor) {
      try {
        const c=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
        if (!validUUID.test(c.id)||typeof c.at!=='string'||Number.isNaN(Date.parse(c.at))) throw Error();
        anchor=[c.at,c.id];
      } catch { throw new DomainError('INVALID_CURSOR'); }
    }
    const w=await this.get(walletId);
    const rows=await banco.query(`SELECT * FROM wallet_ledger WHERE wallet_id=$1
      AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid))
      ORDER BY created_at DESC,id DESC LIMIT $4`,[walletId,anchor?.[0]??null,anchor?.[1]??null,limit+1]);
    const hasMore=rows.length>limit;
    const items=rows.slice(0,limit).map((r:any)=>({id:r.id,transactionId:r.transaction_id,direction:r.direction,
      money:toMoney(r.amount,r.currency),balanceBefore:toMoney(r.balance_before,r.currency),
      balanceAfter:toMoney(r.balance_after,r.currency),createdAt:r.created_at}));
    const last=rows[Math.min(rows.length,limit)-1];
    return {walletId:w.id,items,nextCursor:hasMore&&last?Buffer.from(JSON.stringify({at:last.created_at,id:last.id})).toString('base64url'):null};
  }
  async reconcile(walletId:string) {
    const w=await this.get(walletId);
    const [sum]=await banco.query(`SELECT COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END),0)::text AS total,
      COUNT(*)::int AS entries FROM wallet_ledger WHERE wallet_id=$1`,[walletId]);
    const stored=Money.from(w.balance), calculated=Money.from({amount:sum.total,currency:w.balance.currency},true);
    const difference=stored.subtract(calculated);
    if(!difference.isZero()) console.error(JSON.stringify({event:'reconciliation_mismatch',walletId}));
    return {walletId,storedBalance:stored.toJSON(),calculatedBalance:calculated.toJSON(),
      difference:difference.toJSON(),consistent:difference.isZero(),checkedEntries:sum.entries};
  }
}
