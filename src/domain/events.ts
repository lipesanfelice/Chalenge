/** Eventos de integração fortemente tipados: o tipo não é uma string arbitrária no call site. */
export type EventProps<T>={
  eventId:string;aggregateId:string;correlationId:string;causationId?:string;occurredAt:Date;data:T;
};
export abstract class IntegrationEvent<T> {
  abstract readonly eventType:string;
  abstract readonly version:number;
  protected constructor(protected readonly props:EventProps<T>) {}
  toJSON() { return {eventId:this.props.eventId,eventType:this.eventType,version:this.version,
    aggregateId:this.props.aggregateId,correlationId:this.props.correlationId,
    ...(this.props.causationId?{causationId:this.props.causationId}:{}),
    occurredAt:this.props.occurredAt.toISOString(),data:this.props.data}; }
}
export class WagerTransactionProcessed extends IntegrationEvent<{transactionId:string;kind:string}> {
  readonly eventType='WagerTransactionProcessed';readonly version=1;
  static from(props:EventProps<{transactionId:string;kind:string}>) {return new WagerTransactionProcessed(props);}
}
export class WagerTransactionRejected extends IntegrationEvent<{transactionId:string;code:string}> {
  readonly eventType='WagerTransactionRejected';readonly version=1;
  static from(props:EventProps<{transactionId:string;code:string}>) {return new WagerTransactionRejected(props);}
}
export class WagerTransactionPendingReference extends IntegrationEvent<{transactionId:string}> {
  readonly eventType='WagerTransactionPendingReference';readonly version=1;
  static from(props:EventProps<{transactionId:string}>) {return new WagerTransactionPendingReference(props);}
}
export class WalletBalanceChanged extends IntegrationEvent<{
  walletId:string;transactionId:string;direction:string;money:{amount:string;currency:string};
  balanceBefore:{amount:string;currency:string};balanceAfter:{amount:string;currency:string};walletVersion:number;
}> {
  readonly eventType='WalletBalanceChanged';readonly version=1;
  static from(props:EventProps<{
    walletId:string;transactionId:string;direction:string;money:{amount:string;currency:string};
    balanceBefore:{amount:string;currency:string};balanceAfter:{amount:string;currency:string};walletVersion:number;
  }>) {return new WalletBalanceChanged(props);}
}
