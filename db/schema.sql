CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPES pipeline_status AS ENUM (
    'new',
    'enriched',
    'drafted',
    'approved',
    'sent',
    'replied',
    'bounced',
    'failed',
    'skipped'
);

CREATE TYPES verification_status AS ENUM (
    'unverified',
    'valid',
    'risky',
    'invalid',
    'unknown'
);

CREATE TYPE email_log_event AS ENUM (
    'queued',
    'sent',
    'delivered',
    'opened',
    'clicked',
    'replied',
    'bounced',
    'complained',
    'unsubscribed'
);

CREATE TABLE prospects (
    id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    full_name                    TEXT NOT NULL,
    first_name                   TEXT NOT NULL
    last_name                    TEXT,
    job_title                    TEXT,
    email                        CITEXT,
    linkedin_url                 TEXT

    comapany_name                TEXT NOT NULL,
    company_domain               TEXT,
    company_industry             TEXT,

    raw_source_text              TEXT,
    source_url                   TEXT,

    trigger_event                 TEXT,
    icebreaker_hook               TEXT,
    hypothesized_bottleneck       TEXT,
    proposed_solution             TEXT,
    subject_line_1                TEXT,
    subject_line_2                TEXT,
    subject_line_3                TEXT,
    email_body                    TEXT,

    verification_status           verification_status NOT NULL DEFAULT 'unverified',
    verification_checked_at       TIMESTAMPTZ,
    mx_record_found               BOOLEAN,

    status                        pipeline_status NOT NULL DEFAULT 'new',
    status_updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error                    TEXT,
    retry_count                   INTEGER NOT NULL DEFAULT 0,

    created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
)

CREATE EXTENSION IF NOT EXISTS citext;

CREATE UNIQUE INDEX idx_prospects_email_unique ON prospects (email) WHERE email IS NOT NULL;
CREATE INDEX idx_prospects_status ON prospects (status);
CREATE INDEX idx_prospects_company_domain ON prospects (company_domain);
CREATE INDEverifiX idx_prospects_status_updated_at ON prospects (status, status_updated_at);

-- keep updated_at fresh on every row change
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prospects_updated_at
    BEFORE UPDATE ON prospects
    FOR EACH ROW EXECUTE FUNCTION set_updated_at

-- auto-stamp status_updated_at whenever status changes
CREATE OR REPLACE FUNCTION set_status_updated_at() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        NEW.status_updated_at = now();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql

CREATE TRIGGER trg_prospects_status_updated_at
  BEFORE UPDATE ON prospects
  FOR EACH ROW EXECUTE FUNCTION set_status_updated_at();

CREATE TABLE email_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id     UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,

  touch_number    INTEGER NOT NULL DEFAULT 1,   -- 1 = initial, 2+ = follow-ups
  subject_used    TEXT,
  body_used       TEXT,

  event           email_log_event NOT NULL,
  event_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  provider_message_id TEXT,        -- ESP message id, for webhook correlation
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- raw webhook payload, headers, etc.

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_logs_prospect_id ON email_logs (prospect_id);
CREATE INDEX idx_email_logs_event ON email_logs (event);
CREATE INDEX idx_email_logs_prospect_touch ON email_logs (prospect_id, touch_number);

-- Convenience view: latest event per prospect
CREATE VIEW prospect_latest_touch AS
SELECT DISTINCT ON (prospect_id)
  prospect_id, touch_number, event, event_at
FROM email_logs
ORDER BY prospect_id, event_at DESC;