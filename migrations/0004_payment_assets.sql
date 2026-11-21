-- Record which stablecoin paid for each lookup (USDC, PYUSD, or USDT mint).
-- Existing paid rows were all USDC.
ALTER TABLE queries ADD COLUMN payment_asset TEXT;
ALTER TABLE ledger_entries ADD COLUMN payment_asset TEXT;
ALTER TABLE settled_payments ADD COLUMN asset TEXT;
UPDATE queries SET payment_asset = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' WHERE payment_mode = 'x402' AND payment_asset IS NULL;
UPDATE ledger_entries SET payment_asset = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' WHERE payment_asset IS NULL AND query_id IN (SELECT id FROM queries WHERE payment_mode = 'x402');
UPDATE settled_payments SET asset = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' WHERE asset IS NULL;
