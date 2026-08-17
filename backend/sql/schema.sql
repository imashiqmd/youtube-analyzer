CREATE TABLE IF NOT EXISTS channels (
  channel_id TEXT PRIMARY KEY,
  handle TEXT,
  uploads_playlist_id TEXT NOT NULL,
  channel_data JSONB NOT NULL,
  video_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_channels_handle_lower ON channels (LOWER(handle));
CREATE INDEX IF NOT EXISTS idx_channels_last_synced_at ON channels (last_synced_at);

CREATE TABLE IF NOT EXISTS videos (
  video_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  raw_data JSONB NOT NULL,
  published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_videos_channel_position ON videos (channel_id, position);

CREATE TABLE IF NOT EXISTS quota_logs (
  id BIGSERIAL PRIMARY KEY,
  endpoint TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 1,
  channel_id TEXT,
  request_source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quota_logs_created_at ON quota_logs (created_at DESC);
