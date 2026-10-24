-- Todo valor financeiro é NUMERIC(20,2), jamais ponto flutuante.
CREATE TABLE wallets (
 id uuid PRIMARY KEY, player_id uuid NOT NULL, currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 balance numeric(20,2) NOT NULL DEFAULT 0 CHECK (balance >= 0), version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(player_id,currency)
);
CREATE TABLE wager_transactions (
 id uuid PRIMARY KEY, provider_id text NOT NULL, external_transaction_id text NOT NULL,
 idempotency_key text NOT NULL UNIQUE, payload_hash char(64) NOT NULL,
 wallet_id uuid NOT NULL REFERENCES wallets(id), player_id uuid NOT NULL,
 round_id text NOT NULL, game_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
 amount numeric(20,2) NOT NULL CHECK(amount >= 0), currency varchar(3) NOT NULL,
 reference_external_transaction_id text, reference_transaction_id uuid REFERENCES wager_transactions(id),
 status text NOT NULL CHECK(status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
 failure_code text, result_balance numeric(20,2),
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
 UNIQUE(provider_id, external_transaction_id),
 CHECK(kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
 CHECK((status <> 'REJECTED') OR failure_code IS NOT NULL),
 CHECK((status NOT IN ('PROCESSED','REJECTED','FAILED')) OR processed_at IS NOT NULL)
);
CREATE UNIQUE INDEX one_reversal_per_kind ON wager_transactions(reference_transaction_id,kind)
 WHERE reference_transaction_id IS NOT NULL AND kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';
CREATE INDEX pending_references ON wager_transactions(next_attempt_at) WHERE status = 'PENDING_REFERENCE';
CREATE TABLE wallet_ledger (
 id uuid PRIMARY KEY, wallet_id uuid NOT NULL REFERENCES wallets(id),
 transaction_id uuid NOT NULL UNIQUE REFERENCES wager_transactions(id),
 direction text NOT NULL CHECK(direction IN ('CREDIT','DEBIT')),
 amount numeric(20,2) NOT NULL CHECK(amount > 0), currency varchar(3) NOT NULL,
 balance_before numeric(20,2) NOT NULL CHECK(balance_before >= 0),
 balance_after numeric(20,2) NOT NULL CHECK(balance_after >= 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((direction='CREDIT' AND balance_after=balance_before+amount)
 OR (direction='DEBIT' AND balance_after=balance_before-amount))
);
CREATE INDEX wallet_ledger_cursor ON wallet_ledger(wallet_id,created_at,id);
CREATE TABLE inbox_messages (
 consumer_name text NOT NULL, message_id text NOT NULL, payload_hash char(64) NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(consumer_name,message_id)
);
CREATE TABLE outbox_messages (
 id uuid PRIMARY KEY, aggregate_id uuid NOT NULL, event_type text NOT NULL,
 payload jsonb NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz
);
CREATE INDEX outbox_due ON outbox_messages(next_attempt_at) WHERE published_at IS NULL;
CREATE TABLE metrics (name text PRIMARY KEY, value bigint NOT NULL DEFAULT 0);
-- Imutabilidade no banco, inclusive contra UPDATE/DELETE direto fora da API.
CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ledger is append-only'; END $$;
CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON wallet_ledger
 FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
-- Impede voltar de estado terminal inclusive por SQL arbitrário.
CREATE FUNCTION protect_terminal_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
  RAISE EXCEPTION 'terminal transaction is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER transaction_terminal BEFORE UPDATE ON wager_transactions
 FOR EACH ROW EXECUTE FUNCTION protect_terminal_transaction();
-- Toda movimentação materializada é gerada pelo INSERT contábil na mesma transação.
-- Um único UPDATE condicional serializa concorrência na wallet e impede negativo.
CREATE FUNCTION apply_ledger_to_wallet() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_balance numeric(20,2); after_balance numeric(20,2); wallet_currency text;
BEGIN
 SELECT balance,currency INTO before_balance,wallet_currency FROM wallets WHERE id=NEW.wallet_id FOR UPDATE;
 IF wallet_currency IS NULL OR wallet_currency <> NEW.currency THEN RAISE EXCEPTION 'ledger currency mismatch'; END IF;
 IF before_balance <> NEW.balance_before THEN RAISE EXCEPTION 'ledger balance_before mismatch'; END IF;
 after_balance := CASE WHEN NEW.direction='DEBIT' THEN before_balance-NEW.amount ELSE before_balance+NEW.amount END;
 IF after_balance < 0 THEN RAISE EXCEPTION 'negative balance'; END IF;
 IF after_balance <> NEW.balance_after THEN RAISE EXCEPTION 'ledger balance_after mismatch'; END IF;
 UPDATE wallets SET balance=after_balance,version=version + CASE WHEN (SELECT kind FROM wager_transactions WHERE id=NEW.transaction_id)='OPENING' THEN 0 ELSE 1 END,updated_at=now() WHERE id=NEW.wallet_id;
 RETURN NEW;
END $$;
CREATE TRIGGER ledger_updates_wallet AFTER INSERT ON wallet_ledger
 FOR EACH ROW EXECUTE FUNCTION apply_ledger_to_wallet();
