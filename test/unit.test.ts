import { describe, expect, test } from 'bun:test';
import { Money, DomainError } from '../src/domain/money';
import { Wallet, WalletLedgerEntry, WagerTransaction } from '../src/domain/models';
import { canonical, hash } from '../src/infrastructure/common';
import { validateInput } from '../src/services/wager.service';
const m=(amount:string,currency='BRL')=>Money.from({amount,currency});

describe('Money: valores exatos e imutáveis',()=>{
  test('adição e subtração não usam ponto flutuante',()=>{
    expect(m('0.10').add(m('0.20')).toString()).toBe('0.30');
    expect(m('100.00').subtract(m('80.00')).toString()).toBe('20.00');
  });
  test('normalização e formato fixo',()=>{
    expect(m('1.00').toJSON()).toEqual({amount:'1.00',currency:'BRL'});
  });
  test('rejeita entradas inválidas e arredondamento implícito',()=>{
    for(const x of ['','NaN','Infinity','1e2','12','12.000','-0.01','01.00'])
      expect(()=>m(x)).toThrow();
  });
  test('rejeita moedas conflitantes',()=>{
    expect(()=>m('1.00').add(m('1.00','USD'))).toThrow();
  });
});
describe('Wallet, lançamento e transições',()=>{
  test('débito atualiza saldo e versão',()=>{
    const wallet=Wallet.open(crypto.randomUUID(),crypto.randomUUID(),m('100.00'));
    const {before,after}=wallet.apply(m('80.00'),'DEBIT');
    expect(after.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(WalletLedgerEntry.create(wallet.id,crypto.randomUUID(),'DEBIT',m('80.00'),before,after)).toBeDefined();
  });
  test('nunca permite saldo negativo',()=>{
    const w=Wallet.open(crypto.randomUUID(),crypto.randomUUID(),m('20.00'));
    expect(()=>w.apply(m('80.00'),'DEBIT')).toThrow();
    expect(w.balance.toString()).toBe('20.00');
  });
  test('ledger rejeita uma conta que não fecha',()=>{
    expect(()=>WalletLedgerEntry.create('w','t','DEBIT',m('10.00'),m('100.00'),m('80.00'))).toThrow();
  });
  test('estado terminal não muda',()=>{
    const t=WagerTransaction.create('t','LOSS',false);t.markProcessed();
    expect(()=>t.reject('X')).toThrow();
  });
  test('reversão exige referência',()=>{
    expect(()=>WagerTransaction.create('t','REFUND',false)).toThrow();
  });
});
describe('Idempotência',()=>{
  test('a ordenação de chaves não modifica o hash',()=>{
    expect(hash({b:2,a:1})).toBe(hash({a:1,b:2}));
    expect(hash({a:1})).not.toBe(hash({a:2}));
  });
  test('não permite OPENING via input externo',()=>{
    expect(()=>validateInput({kind:'OPENING'} as any)).toThrow();
  });
});
