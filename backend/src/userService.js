import { pool } from "./db.js";

export async function logUserActivity(userId, action, { channelId = null, metadata = {} } = {}) {
  if (!userId || !action) return;
  await pool.query(
    `INSERT INTO user_activity (user_id, action, channel_id, metadata)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [userId, action, channelId, JSON.stringify(metadata || {})]
  );
}

export async function listSavedChannels(userId) {
  const { rows } = await pool.query(
    `SELECT usc.channel_id, usc.title, usc.thumbnail, usc.query, usc.created_at,
            c.last_synced_at
     FROM user_saved_channels usc
     LEFT JOIN channels c ON c.channel_id = usc.channel_id
     WHERE usc.user_id = $1
     ORDER BY usc.created_at DESC`,
    [userId]
  );
  return rows.map((row) => ({
    id: row.channel_id,
    title: row.title,
    thumbnail: row.thumbnail || "",
    query: row.query || ("https://www.youtube.com/channel/" + row.channel_id),
    savedAt: row.created_at,
    lastSyncedAt: row.last_synced_at,
  }));
}

export async function saveChannelForUser(userId, { channelId, title, thumbnail, query }) {
  await pool.query(
    `INSERT INTO user_saved_channels (user_id, channel_id, title, thumbnail, query)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, channel_id) DO UPDATE SET
       title = EXCLUDED.title,
       thumbnail = EXCLUDED.thumbnail,
       query = EXCLUDED.query`,
    [userId, channelId, title, thumbnail || null, query || null]
  );
  await logUserActivity(userId, "save_channel", {
    channelId,
    metadata: { title },
  });
}

export async function removeSavedChannel(userId, channelId) {
  const { rowCount } = await pool.query(
    `DELETE FROM user_saved_channels
     WHERE user_id = $1 AND channel_id = $2`,
    [userId, channelId]
  );
  if (rowCount > 0) {
    await logUserActivity(userId, "unsave_channel", { channelId });
  }
  return rowCount > 0;
}
