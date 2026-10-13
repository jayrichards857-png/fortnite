-- Serverless-safe shared state (Vercel runs many short-lived instances, so per-process memory cannot rate-limit or coordinate jobs).

-- Fixed-window request counters shared by every instance. One row per (key, window).
CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  bucket BIGINT NOT NULL,                 -- floor(now / window length)
  hits INTEGER NOT NULL,
  expires_at BIGINT NOT NULL,             -- end of the window; rows are purged after this
  PRIMARY KEY (key, bucket)
);
CREATE INDEX idx_rate_limits_expiry ON rate_limits(expires_at);

-- One row per scheduled job: a lease so overlapping invocations (retries, two schedulers, manual runs) never run the same job twice at once,
-- plus the last outcome for operators.
CREATE TABLE job_leases (
  name TEXT PRIMARY KEY,
  locked_until BIGINT NOT NULL DEFAULT 0,
  last_started_at BIGINT,
  last_finished_at BIGINT,
  last_status TEXT,
  runs BIGINT NOT NULL DEFAULT 0
);
