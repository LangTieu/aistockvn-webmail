-- migrations/0018_ai_rate_limits.sql
-- Daily AI call counter (Workers AI guardrail, 20/11/2026).
-- Workers AI free allocation is 10,000 neurons/day (shared across the whole
-- account: webmail AI + the Qoder/router leg). gpt-oss-120b costs 31,818
-- neurons/M input tokens + 68,182/M output tokens, so one webmail
-- summarize/draft call is at most ~90 neurons after input truncation
-- (8000 chars ~= 2000 input tokens). A global cap of 60 calls/day bounds
-- the webmail to ~5,400 neurons/day worst case and stops a runaway loop
-- from starving the daily pool. Over the cap the Worker returns a clear
-- "daily limit reached" error (no charge is possible on Workers Free --
-- over the 10,000-neuron allocation requests fail, they are never billed).
CREATE TABLE IF NOT EXISTS ai_rate_limits (
  scope TEXT NOT NULL,
  day TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, day)
);
