-- Admin (control) tokens for the MockPay admin API and console.
-- Only a sha256 hash is stored; the token itself is shown once when it is generated.
CREATE TABLE admin_tokens (
  id           text PRIMARY KEY,                 -- tok_...
  name         text NOT NULL,
  token_hash   text UNIQUE NOT NULL,
  token_hint   text NOT NULL,                    -- last 4 characters, to recognise it
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
