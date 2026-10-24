DROP TABLE IF EXISTS metrics, outbox_messages, inbox_messages, wallet_ledger, wager_transactions, wallets CASCADE;
DROP FUNCTION IF EXISTS apply_ledger_to_wallet(), protect_terminal_transaction(), forbid_ledger_mutation();
