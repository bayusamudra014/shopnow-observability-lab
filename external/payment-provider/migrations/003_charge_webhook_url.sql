-- One MockPay can serve several shops: each charge remembers where to send its webhooks.
ALTER TABLE charges ADD COLUMN webhook_url text;
