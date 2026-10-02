CREATE TABLE IF NOT EXISTS payments (
 id uuid PRIMARY KEY,
 amount_cents integer NOT NULL CHECK (amount_cents > 0),
 currency text NOT NULL CHECK (currency IN ('USD','BRL','EUR')),
 mode text NOT NULL CHECK (mode IN ('success','temporary','declined','timeout','unavailable')),
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','succeeded','declined','unknown')),
 attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid,
 leased_until timestamptz,
 provider_reference text UNIQUE,
 last_error text,
 needs_review boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_work_idx ON payments(available_at) WHERE NOT needs_review AND status IN ('queued','processing','unknown');
CREATE TABLE IF NOT EXISTS request_keys (
 key text PRIMARY KEY,
 request_hash text NOT NULL,
 payment_id uuid NOT NULL UNIQUE REFERENCES payments(id)
);
CREATE TABLE IF NOT EXISTS payment_events (
 id bigserial PRIMARY KEY,
 payment_id uuid NOT NULL REFERENCES payments(id),
 event_type text NOT NULL,
 details jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
-- Provider state belongs to the simulator, not to the payment service.
-- Sharing one database simplifies local execution; the adapter only uses HTTP.
CREATE TABLE IF NOT EXISTS provider_attempts (key uuid PRIMARY KEY, attempts integer NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS provider_charges (
 key uuid PRIMARY KEY,
 reference text NOT NULL UNIQUE,
 amount_cents integer NOT NULL,
 currency text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
