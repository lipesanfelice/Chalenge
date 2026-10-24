# Arquitetura e decisões técnicas

## Visão geral

```text
API HTTP ──┐
           ├── WagerService ── PostgreSQL (wallets, transactions, ledger, inbox, outbox)
SQS inbox ─┘                        │
                            commit financeiro
                                   │
                         workers outbox (SKIP LOCKED)
                                   │
                           SQS wager-events.fifo

Worker agendado ── consulta PENDING_REFERENCE ── WagerService
```

**Stack:** NestJS + Bun 1.x + TypeScript strict, TypeORM (`DataSource`/`QueryRunner`), PostgreSQL e SQS/LocalStack. Usa SQL parametrizado na camada transacional crítica, em vez de depender de uma abstração que oculte os locks e a ordem dos statements. `Money` é independente de NestJS/ORM e usa `decimal.js`, sem tipo `number` para valores financeiros. PostgreSQL mantém `NUMERIC(20,2)`.

## Garantias importantes

1. **Wallet única:** `UNIQUE(player_id,currency)`.
2. **Saldo não negativo:** `CHECK(balance >= 0)` e validação no domínio. O trigger do ledger faz `SELECT ... FOR UPDATE` por wallet, verifica o saldo anterior e aplica a movimentação sob lock; o crédito/débito e ledger não sobrevivem isoladamente a um rollback.
3. **Ledger append-only:** trigger proíbe `UPDATE` ou `DELETE`. `UNIQUE(transaction_id)` impede um segundo lançamento da mesma transação. Checks verificam `before ± amount = after`.
4. **Concorrência:** lock **local à wallet**: `SELECT FOR UPDATE` por id; múltiplas instâncias partilham a mesma serialização no banco, sem mutex em memória. A operação só termina quando saldo, ledger, transaction e eventos foram confirmados juntos.
5. **Idempotência durável:** `UNIQUE(idempotency_key)` e `UNIQUE(provider_id,external_transaction_id)`. SHA-256 de JSON canônico: chaves de objetos ordenadas recursivamente e campos indefinidos omitidos. Header é excluído do hash. Mesmo hash retorna a resposta/saldo originalmente materializados; hash divergente gera conflito.
6. **Inbox:** a chave `(consumer_name,message_id)` é persistente e fica na transação SQL da operação. O `ack` ocorre após `commit`. Não depende apenas de FIFO.
7. **Outbox:** o registro do evento faz parte do mesmo commit financeiro; publishers concorrentes selecionam `FOR UPDATE SKIP LOCKED`. Falha de envio retenta com backoff exponencial. Após envio bem-sucedido e antes de marcar `published_at`, um crash pode provocar duplicidade; o contrato exige consumidores deduplicarem por `eventId` (at-least-once, não exatamente uma vez).
8. **Referência fora de ordem:** `PENDING_REFERENCE`, nova tentativa com backoff exponencial a cada varredura, limite de 8 verificações; após o limite, `REFERENCE_NOT_FOUND`. Enquanto pendente, a wallet não muda.
9. **Estado terminal:** trigger impede edição de transação finalizada e o domínio também rejeita transições.
10. **Criação da wallet:** transação interna `OPENING` e ledger de crédito atômico. A versão fica em 1 após a abertura, de acordo com o contrato.

## Regras de negócios adotadas

- `BET` debita; `WIN` credita; `LOSS` apenas registra resultado; `REFUND` credita sobre BET processada; `ROLLBACK` inverte BET/WIN/REFUND.
- `WIN` aceita (mas não exige) referência a uma BET; este recorte não valida a referência opcional de WIN.
- Reversão: mesmo provedor, jogador, wallet, rodada, moeda e valor, com referência processada. Cada referência só pode ter uma reversão processada de cada kind. `ROLLBACK` contra `WIN` ou `REFUND` que geraria negativo é recusado como `REVERSAL_INSUFFICIENT_FUNDS`.
- Não há suporte a reversão parcial nem múltiplas moedas dentro da mesma wallet.

## Mapeamento HTTP / erros

| Situação | Código |
|---|---|
| Criado / processado | 201 em POST; 200 em GET |
| Pendente | 202 |
| Regra financeira rejeitada | 422 |
| Payload inválido | 400 |
| Mesmo idempotency key com hash diferente | 409 |
| Wallet duplicada | 409 |
| Não encontrado | 404 |
| PostgreSQL/SQS indisponível | 503 |

Falhas estáveis: `INVALID_PAYLOAD`, `INVALID_MONEY`, `INVALID_CURRENCY`, `INVALID_IDEMPOTENCY_KEY`, `IDEMPOTENCY_CONFLICT`, `WALLET_MISMATCH`, `REFERENCE_REQUIRED`, `REFERENCE_NOT_FOUND`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_MISMATCH`, `REFERENCE_AMOUNT_MISMATCH`, `INVALID_REFERENCE_KIND`, `ALREADY_REVERSED`, `INSUFFICIENT_FUNDS`, `REVERSAL_INSUFFICIENT_FUNDS`.

## Autenticação

**Não implementada por prioridade de timebox**, conforme permitido na seção 2 do enunciado. A extensão recomendada é um NestJS Guard com JWKS/OIDC validando JWT de Keycloak e mapeando `providerId` autorizado do token para as operações solicitadas. A entrada SQS deveria ser restrita por IAM ao produtor e ter origem do provider validada por política do sistema. Não utilizar este projeto em ambiente público sem implementar esse controle.

## Observabilidade e limitações atuais

- Logs JSON são emitidos para processamento/ACK/retry com identificadores e sem payload financeiro completo.
- Liveness e readiness verificam processo, Postgres e SQS.
- **Limitação conhecida:** métricas persistentes detalhadas ainda não foram instrumentadas; a tabela `metrics` está reservada para isso. Também faltam testes automatizados de falha real do SQS, kill entre commit e ack, paralelismo de três processos distintos, publicação concorrente, reinícios e DLQ.
- O teste de integração presente usa PostgreSQL real; **não** foi possível executá-lo neste ambiente por ausência de Bun/Docker. É um ponto de partida, não prova de conformidade com toda a matriz de testes.
- Workers fazem polling e drenagem em SIGTERM ao fim do lote atual, mas não renovam visibility timeout em operações longas. Para produção, adicionar heartbeat da visibilidade, telemetria Prometheus/OTel, limite operacional de outbox e alertas de DLQ.
- Outbox é entregue em fila **separada** da fila de entrada para evitar que eventos de saída sejam confundidos com solicitações financeiras.
- A restrição de todas as alterações de saldo passarem por lançamento é garantida no caminho de aplicação, mas um operador com permissão SQL de UPDATE direto sobre wallets pode quebrá-la. Produção deve revogar essa permissão ao usuário da aplicação e usar função SQL `SECURITY DEFINER` dedicada ao movimento contábil, ou reforçar com triggers de proteção.
- Não há proteção contra um cliente manipular diretamente identificadores de provider porque autenticação ficou fora do escopo desta versão.

## Testes e demonstração de concorrência

`test/unit.test.ts` cobre Money, saldo, ledger, transições e hash. `test/integration.test.ts` faz **50 replays paralelos**, disputa simultânea pelo saldo, conflitos de chave e referência fora de ordem em PostgreSQL. Para demonstrar três processos: `docker compose up -d --scale worker=3` em uma configuração sem nomes fixos, ou usar os três workers definidos (`worker`, `worker2`, `worker3`). Os testes funcionais restantes do enunciado precisam ser implementados antes de considerar o desafio inteiramente concluído.

## Trade-offs

Pessimistic locking simplifica a demonstração de correção, ao custo de espera sob hot wallets. SQS FIFO por wallet reduz desordem, mas **não** substitui locks de PostgreSQL. Eventual consistency é tolerada na publicação para SQS, porém nunca na dupla saldo/ledger. Ledger simples atende ao mínimo, mas não é contabilidade de partidas dobradas.
