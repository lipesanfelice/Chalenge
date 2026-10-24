import 'reflect-metadata';
import { Module, Catch, ArgumentsHost, ExceptionFilter, HttpException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiController } from './http/controller';
import { WalletService } from './services/wallet.service';
import { WagerService } from './services/wager.service';
import { banco } from './infrastructure/common';
import { DomainError } from './domain/money';

@Catch()
class ErrorFilter implements ExceptionFilter {
  catch(error:any,host:ArgumentsHost) {
    const response=host.switchToHttp().getResponse();
    const code=error instanceof DomainError ? error.code : 'INFRASTRUCTURE_UNAVAILABLE';
    const http=error instanceof HttpException ? error.getStatus() :
      code==='IDEMPOTENCY_CONFLICT'||code==='WALLET_ALREADY_EXISTS'||code==='INBOX_MESSAGE_CONFLICT'?409:
      code.endsWith('_NOT_FOUND')&&code!=='REFERENCE_NOT_FOUND'?404:
      error instanceof DomainError?400:503;
    response.status(http).json(error instanceof HttpException?error.getResponse():{code,message:code});
    if(!(error instanceof DomainError)&&!(error instanceof HttpException))
      console.error(JSON.stringify({event:'request_error',code:'INFRASTRUCTURE_UNAVAILABLE'}));
  }
}
@Module({controllers:[ApiController],providers:[WalletService,WagerService]})
class AppModule {}
await banco.initialize();
const app=await NestFactory.create(AppModule,{logger:['error','warn']});
app.useGlobalFilters(new ErrorFilter());
app.enableShutdownHooks();
await app.listen(Number(process.env.PORT??3000),'0.0.0.0');
console.log(JSON.stringify({event:'api_started',port:process.env.PORT??3000}));
