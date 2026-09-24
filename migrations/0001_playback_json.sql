CREATE TABLE IF NOT EXISTS playback_json (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, key)
);

CREATE INDEX IF NOT EXISTS playback_json_updated_at
  ON playback_json (updated_at);
