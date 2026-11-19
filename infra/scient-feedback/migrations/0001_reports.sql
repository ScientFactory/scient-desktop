-- One row per installation that has sent feedback: the first token seen binds the client id.
CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

-- `report` is the validated report JSON as the app sent it; attachments live in R2 under
-- reports/<id>/<kind>.
CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  report TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  fixed_in TEXT,
  note TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX reports_status_received ON reports (status, received_at);
CREATE INDEX reports_client_received ON reports (client_id, received_at);
CREATE INDEX reports_received ON reports (received_at);
