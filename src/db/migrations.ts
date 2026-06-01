export type Migration = {
  id: string;
  sql: string;
};

export const migrations: Migration[] = [
  {
    id: '0001_core_tables',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        trust_state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY,
        session_id TEXT,
        event_type TEXT NOT NULL,
        source TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_session_sequence ON events(session_id, sequence);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pairing_sessions (
        id TEXT PRIMARY KEY,
        challenge TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );
    `
  },
  {
    id: '0002_session_event_enhancements',
    sql: `
      ALTER TABLE sessions ADD COLUMN profile TEXT DEFAULT 'default';
      ALTER TABLE events ADD COLUMN timestamp TEXT DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE events ADD COLUMN stream_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
    `
  },
  {
    id: '0003_security_pairing',
    sql: `
      ALTER TABLE pairing_sessions ADD COLUMN payload_json TEXT;
      ALTER TABLE pairing_sessions ADD COLUMN completed_at TEXT;
      ALTER TABLE pairing_sessions ADD COLUMN device_id TEXT;

      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        FOREIGN KEY(device_id) REFERENCES devices(id)
      );

      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_device_id ON refresh_tokens(device_id);
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);
    `
  },
  {
    id: '0004_session_titles_and_hidden',
    sql: `
      ALTER TABLE sessions ADD COLUMN title TEXT;

      CREATE TABLE IF NOT EXISTS hidden_sessions (
        id TEXT PRIMARY KEY,
        hidden_at TEXT NOT NULL
      );
    `
  }
];