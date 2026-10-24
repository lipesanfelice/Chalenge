import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { banco } from '../src/infrastructure/common';
import { WalletService } from '../src/services/wallet.service';
import { WagerService } from '../src/services/wager.service';
import type { WagerInput } from '../src/services/wager.service';

// Integração REAL: requer postgres migrado; o teste não substitui SQL por mocks.
const wallets=new WalletService(), wagers=new WagerService();
let walletId='',playerId='';
const wager=(externalTransactionId:string,kind:WagerInput['kind'],amount:string,referenceExternalTransactionId?:string):WagerInput=>({
  providerId:'integration-test',externalTransactionId,playerId,walletId,roundId:'round-1',gameId:'game-1',kind,
  money:{amount,currency:'BRL'},...(referenceExternalTransactionId?{referenceExternalTransactionId}:{})
});
const random=()=>crypto.randomUUID();
let prefix='';
beforeAll(async()=>{
  await banco.initialize();prefix=random();playerId=random();
  walletId=(await wallets.create(playerId,{amount:'100.00',currency:'BRL'})).id;
});
afterAll(async()=>{await banco.destroy();});
describe('Concurrência no PostgreSQL',()=>{
  test('50 replays em paralelo debitam uma vez',async()=>{
    const v=wager(`${prefix}:bet-1`,'BET','10.00');const key=`${prefix}:idempo-1`;
    const res=await Promise.all(Array.from({length:50},()=>wagers.execute(v,key)));
    expect(new Set(res.map(x=>x.transactionId)).size).toBe(1);
    expect((await wallets.get(walletId)).balance.amount).toBe('90.00');
    const [count]=await banco.query(`SELECT COUNT(*)::int AS n FROM wallet_ledger WHERE wallet_id=$1 AND direction='DEBIT'`,[walletId]);
    expect(count.n).toBe(1);
  });
  test('chave repetida e payload diferente retorna conflito',async()=>{
    const key=`${prefix}:idempo-1`;
    await expect(wagers.execute(wager(`${prefix}:bet-1`,'BET','20.00'),key)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  });
  test('duas apostas de 80 disputam 90; somente uma processa',async()=>{
    const results=await Promise.all([wagers.execute(wager(`${prefix}:bet-2`,'BET','80.00'),`${prefix}:key-2`),
      wagers.execute(wager(`${prefix}:bet-3`,'BET','80.00'),`${prefix}:key-3`)]);
    expect(results.map(r=>r.status).sort()).toEqual(['PROCESSED','REJECTED']);
    expect((await wallets.get(walletId)).balance.amount).toBe('10.00');
  });
  test('reversão antecipada fica pendente e depois aplica uma vez',async()=>{
    const ref=`${prefix}:future-bet`,rb=`${prefix}:refund`;
    const pending=await wagers.execute(wager(rb,'REFUND','5.00',ref),`${prefix}:key-rb`);
    expect(pending.status).toBe('PENDING_REFERENCE');
    await wagers.execute(wager(ref,'BET','5.00'),`${prefix}:key-ref`);
    // No banco o worker não precisa esperar temporizador neste teste.
    await banco.query(`UPDATE wager_transactions SET next_attempt_at=now() WHERE external_transaction_id=$1`,[rb]);
    await wagers.retryReferences();
    expect((await wallets.get(walletId)).balance.amount).toBe('10.00');
  });
  test('reconciliação fecha com ledger',async()=>{
    const result=await wallets.reconcile(walletId);
    expect(result.consistent).toBe(true);
    expect(result.difference.amount).toBe('0.00');
  });
});
