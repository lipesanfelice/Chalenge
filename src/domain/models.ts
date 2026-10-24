import { DomainError, Money } from './money';
export type Kind = 'OPENING' | 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
export type Status = 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';
export type Direction = 'DEBIT' | 'CREDIT';
export type WalletState = { id: string; playerId: string; balance: Money; version: number; createdAt: Date; updatedAt: Date };

/** Aggregate Root. Cada movimento altera saldo e versão uma única vez. */
export class Wallet {
  private constructor(public readonly id: string, public readonly playerId: string, private saldo: Money,
    private versao: number, public readonly createdAt: Date, private ultimaAlteracao: Date) {}
  static open(id: string, playerId: string, initial: Money) {
    if (initial.isNegative()) throw new DomainError('INVALID_MONEY');
    return new Wallet(id, playerId, initial, 1, new Date(), new Date());
  }
  static rehydrate(s: WalletState) { return new Wallet(s.id, s.playerId, s.balance, s.version, s.createdAt, s.updatedAt); }
  get balance() { return this.saldo; }
  get currency() { return this.saldo.currency; }
  get version() { return this.versao; }
  get updatedAt() { return this.ultimaAlteracao; }
  apply(money: Money, direction: Direction): { before: Money; after: Money } {
    const before = this.saldo;
    const after = direction === 'DEBIT' ? before.subtract(money) : before.add(money);
    if (after.isNegative()) throw new DomainError('INSUFFICIENT_FUNDS');
    if (!before.equals(after)) { this.saldo = after; this.versao++; this.ultimaAlteracao = new Date(); }
    return { before, after };
  }
}

/** Ciclo de vida encapsulado; estados terminais são irreversíveis. */
export class WagerTransaction {
  private constructor(public readonly id: string, public readonly kind: Kind, private estado: Status,
    private codigo?: string) {}
  static create(id: string, kind: Kind, hasReference: boolean) {
    if (['REFUND','ROLLBACK'].includes(kind) && !hasReference) throw new DomainError('REFERENCE_REQUIRED');
    return new WagerTransaction(id, kind, 'PENDING');
  }
  static rehydrate(id: string, kind: Kind, status: Status, failureCode?: string) { return new WagerTransaction(id, kind, status, failureCode); }
  get status() { return this.estado; }
  get failureCode() { return this.codigo; }
  isTerminal() { return ['PROCESSED','REJECTED','FAILED'].includes(this.estado); }
  private canTransition() { if (this.isTerminal()) throw new DomainError('INVALID_TRANSACTION_STATE'); }
  markProcessed() { this.canTransition(); this.estado = 'PROCESSED'; }
  markPendingReference() { this.canTransition(); this.estado = 'PENDING_REFERENCE'; }
  reject(code: string) { this.canTransition(); this.estado = 'REJECTED'; this.codigo = code; }
  fail(code: string) { this.canTransition(); this.estado = 'FAILED'; this.codigo = code; }
}

/** Registro contábil intencionalmente sem setters. */
export class WalletLedgerEntry {
  private constructor(public readonly walletId: string, public readonly transactionId: string,
    public readonly direction: Direction, public readonly amount: Money,
    public readonly before: Money, public readonly after: Money) {}
  static create(walletId: string, transactionId: string, direction: Direction, amount: Money, before: Money, after: Money) {
    const expected = direction === 'DEBIT' ? before.subtract(amount) : before.add(amount);
    if (!expected.equals(after)) throw new DomainError('UNBALANCED_LEDGER');
    return new WalletLedgerEntry(walletId, transactionId, direction, amount, before, after);
  }
}
