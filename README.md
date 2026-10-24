# Jungle Gaming — Distributed Wagering Processor

Implementação de um processador financeiro distribuído com **Bun, TypeScript estrito, NestJS, TypeORM, PostgreSQL, SQS e LocalStack**. Os comentários no código explicam decisões importantes, principalmente as de consistência financeira.

## Como executar

Pré-requisitos: Docker com Docker Compose. Na raiz do projeto:

```bash
docker compose up --build -d
curl http://localhost:3000/health/ready
```

A inicialização cria o banco, executa a migration, configura as filas e sobe a API e **três workers** concorrentes.

### Testes

```bash
# Se tiver Bun 1.x instalado no host e os serviços já iniciados:
bun install
bun run test
DATABASE_URL=postgres://jungle:jungle@localhost:5432/jungle bun run test:integration
bun run typecheck
```

> Atenção: a integração requer a migration aplicada. Rode testes de integração em base isolada, pois eles criam dados reais.

## Exemplos

Crie uma wallet:

```bash
curl -s http://localhost:3000/wallets -H 'Content-Type: application/json' -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

Use o `id` retornado como `walletId`:

```bash
curl -s http://localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-1","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"COLE_UUID_AQUI","roundId":"round-1","gameId":"game-1","kind":"BET","money":{"amount":"80.00","currency":"BRL"}}'
```

Repetir exatamente a operação retorna `idempotentReplay: true`, sem segundo débito.

Rotas: `POST /wallets`, `GET /wallets/:id`, `GET /wallets/:id/ledger`, `POST /wallets/:id/reconciliation`, `POST /wagering/transactions`, `GET /wagering/transactions/:id`, `GET /providers/:id/wagering/transactions/:externalId`, `GET /health/live`, `GET /health/ready`.

## Como publicar uma mensagem de entrada

É possível enviar por SQS `wager-transactions.fifo` usando AWS CLI / `awslocal`. O corpo segue o modelo em `CHALLENGE.md`, com `type: "WagerTransactionRequested"`, `messageId` e `data` contendo os mesmos campos do POST mais `idempotencyKey`. Atribua `MessageGroupId` igual ao `walletId` e `MessageDeduplicationId` a um UUID. Saídas são publicadas na fila distinta `wager-events.fifo`.

## Documentação

- [`ARCHITECTURE.md`](ARCHITECTURE.md): decisões e garantias, riscos e limitações.
- [`CHALLENGE.md`](CHALLENGE.md): enunciado original.
- `src/domain`: Money, Wallet, Transaction e Ledger.
- `src/services`: casos de uso de wallets e apostas.
- `src/worker-main.ts`: SQS, retry de referências e outbox.
- `src/db/migrations`: schema com constraints, triggers e reversão.

## Avisos

Este projeto é uma implementação demonstrativa do desafio e **não deve ser usado com dinheiro real sem auditoria, testes de falhas e carga, segurança e homologação**. Não foi possível executar o Docker Compose no ambiente de geração; veja as limitações no arquivo de arquitetura.
