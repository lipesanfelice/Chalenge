import Decimal from 'decimal.js';

/** Valor monetário imutável: nunca converte dinheiro para number. */
export type MoneyProps = { amount: string; currency: string };
export class DomainError extends Error {
  constructor(public readonly code: string, message = code) { super(message); this.name = 'DomainError'; }
}
export class Money {
  private constructor(private readonly value: Decimal, public readonly currency: string) {}
  static from(props: MoneyProps, allowNegative = false): Money {
    if (!props || typeof props.amount !== 'string' || !/^-?(0|[1-9]\d*)\.\d{2}$/.test(props.amount))
      throw new DomainError('INVALID_MONEY', 'Valor deve ser string decimal com exatamente duas casas');
    if (typeof props.currency !== 'string' || !/^[A-Z]{3}$/.test(props.currency))
      throw new DomainError('INVALID_CURRENCY');
    const d = new Decimal(props.amount);
    if (!d.isFinite() || (!allowNegative && d.isNegative())) throw new DomainError('INVALID_MONEY');
    return new Money(d, props.currency);
  }
  static zero(currency: string) { return Money.from({ amount: '0.00', currency }); }
  private assertSame(other: Money) { if (this.currency !== other.currency) throw new DomainError('CURRENCY_MISMATCH'); }
  add(other: Money) { this.assertSame(other); return Money.from({ amount: this.value.plus(other.value).toFixed(2), currency: this.currency }, true); }
  subtract(other: Money) { this.assertSame(other); return Money.from({ amount: this.value.minus(other.value).toFixed(2), currency: this.currency }, true); }
  negate() { return Money.from({ amount: this.value.negated().toFixed(2), currency: this.currency }, true); }
  isZero() { return this.value.isZero(); }
  isPositive() { return this.value.isPositive(); }
  isNegative() { return this.value.isNegative(); }
  isLessThan(other: Money) { this.assertSame(other); return this.value.lt(other.value); }
  equals(other: Money) { this.assertSame(other); return this.value.equals(other.value); }
  toJSON(): MoneyProps { return { amount: this.value.toFixed(2), currency: this.currency }; }
  toString() { return this.value.toFixed(2); }
}
