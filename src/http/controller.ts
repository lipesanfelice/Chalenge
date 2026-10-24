import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { banco, sqs, queueUrl } from '../infrastructure/common';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { WalletService } from '../services/wallet.service';
import { WagerService, type WagerInput } from '../services/wager.service';
import { DomainError, Money } from '../domain/money';
import { HttpException } from '@nestjs/common';

@Controller()
export class ApiController {
  constructor(private readonly wallets:WalletService, private readonly wagers:WagerService) {}
  @Post('wallets')
  create(@Body() body:any) { return this.wallets.create(body?.playerId,body?.initialBalance); }
  @Get('wallets/:walletId')
  get(@Param('walletId') id:string) { return this.wallets.get(id); }
  @Get('wallets/:walletId/ledger')
  ledger(@Param('walletId') id:string,@Query('cursor') cursor?:string,@Query('limit') limit?:string) {
    return this.wallets.ledger(id,cursor,limit===undefined?50:Number(limit));
  }
  @Post('wallets/:walletId/reconciliation')
  reconciliation(@Param('walletId') id:string) { return this.wallets.reconcile(id); }
  @Post('wagering/transactions')
  async submit(@Body() body:WagerInput,@Headers('idempotency-key') key:string) {
    const result=await this.wagers.execute(body,key);
    if(result.status==='REJECTED') throw new HttpException(result,422);
    if(result.status==='PENDING_REFERENCE') throw new HttpException(result,202);
    return result;
  }
  @Get('wagering/transactions/:id')
  async transaction(@Param('id') id:string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new DomainError('INVALID_TRANSACTION_ID');
    const [r]=await banco.query('SELECT * FROM wager_transactions WHERE id=$1',[id]);
    if(!r) throw new DomainError('TRANSACTION_NOT_FOUND');
    return this.dto(r);
  }
  @Get('providers/:providerId/wagering/transactions/:externalId')
  async byExternal(@Param('providerId') providerId:string,@Param('externalId') externalId:string) {
    const [r]=await banco.query('SELECT * FROM wager_transactions WHERE provider_id=$1 AND external_transaction_id=$2',[providerId,externalId]);
    if(!r) throw new DomainError('TRANSACTION_NOT_FOUND');
    return this.dto(r);
  }
  private dto(r:any) { return {transactionId:r.id,status:r.status,kind:r.kind,providerId:r.provider_id,
    externalTransactionId:r.external_transaction_id,failureCode:r.failure_code,
    balance:r.result_balance===null?null:Money.from({amount:r.result_balance,currency:r.currency},true).toJSON()}; }
  @Get('health/live') live() { return {status:'ok'}; }
  @Get('health/ready')
  async ready() {
    try {
      await banco.query('SELECT 1');
      await sqs.send(new GetQueueAttributesCommand({QueueUrl:queueUrl,AttributeNames:['QueueArn']}));
      return {status:'ready',postgres:'ok',sqs:'ok'};
    } catch { throw new HttpException({status:'unready'},503); }
  }
}
