PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS commerce_webhook_events (
  provider TEXT NOT NULL CHECK (provider = 'stripe'),
  provider_event_id TEXT NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 255),
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 255),
  event_created_at INTEGER CHECK (event_created_at IS NULL OR event_created_at >= 0),
  received_at TEXT NOT NULL,
  livemode INTEGER NOT NULL CHECK (livemode IN (0, 1)),
  api_version TEXT CHECK (api_version IS NULL OR length(api_version) BETWEEN 1 AND 80),
  related_object_id TEXT CHECK (related_object_id IS NULL OR length(related_object_id) BETWEEN 1 AND 255),
  related_object_type TEXT CHECK (related_object_type IS NULL OR length(related_object_type) BETWEEN 1 AND 120),
  processing_status TEXT NOT NULL CHECK (processing_status IN ('received', 'accepted_noop', 'ignored', 'error')),
  processed_at TEXT,
  result_code TEXT CHECK (result_code IS NULL OR length(result_code) BETWEEN 1 AND 80),
  payload_sha256 TEXT CHECK (payload_sha256 IS NULL OR (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*')),
  PRIMARY KEY (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_commerce_webhook_events_event_id
  ON commerce_webhook_events(provider_event_id);
CREATE INDEX IF NOT EXISTS idx_commerce_webhook_events_type_created
  ON commerce_webhook_events(provider, event_type, event_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commerce_webhook_events_received
  ON commerce_webhook_events(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_commerce_webhook_events_status
  ON commerce_webhook_events(provider, processing_status, received_at DESC);
