import { withTransaction } from "./db.js";
import { parseChannelAttempts, lookupHandleKey, isCacheFresh } from "./handle.js";
import { fetchChannelFromYouTube, QuotaTracker } from "./youtube.js";

export async function findChannelByLookupKey(client, lookupKey) {
  if (!lookupKey) return null;

  const byHandle = await client.query(
    `SELECT channel_id, handle, uploads_playlist_id, channel_data, video_ids, last_synced_at
     FROM channels
     WHERE LOWER(handle) = LOWER($1)
     LIMIT 1`,
    [lookupKey]
  );
  if (byHandle.rows[0]) return byHandle.rows[0];

  if (/^UC[\w-]{20,}$/.test(lookupKey)) {
    const byId = await client.query(
      `SELECT channel_id, handle, uploads_playlist_id, channel_data, video_ids, last_synced_at
       FROM channels
       WHERE channel_id = $1
       LIMIT 1`,
      [lookupKey]
    );
    if (byId.rows[0]) return byId.rows[0];
  }

  return null;
}

export async function loadChannelVideos(client, channelId) {
  const { rows } = await client.query(
    `SELECT raw_data
     FROM videos
     WHERE channel_id = $1
     ORDER BY position ASC`,
    [channelId]
  );
  return rows.map((row) => row.raw_data);
}

export async function upsertChannelCache(client, {
  channel,
  videoIds,
  rawVideos,
  handleKey,
}) {
  const now = new Date().toISOString();

  await client.query(
    `INSERT INTO channels (
       channel_id, handle, uploads_playlist_id, channel_data, video_ids, last_synced_at, updated_at
     ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $6)
     ON CONFLICT (channel_id) DO UPDATE SET
       handle = EXCLUDED.handle,
       uploads_playlist_id = EXCLUDED.uploads_playlist_id,
       channel_data = EXCLUDED.channel_data,
       video_ids = EXCLUDED.video_ids,
       last_synced_at = EXCLUDED.last_synced_at,
       updated_at = EXCLUDED.updated_at`,
    [
      channel.id,
      handleKey,
      channel.uploadsPlaylistId,
      JSON.stringify(channel),
      JSON.stringify(videoIds),
      now,
    ]
  );

  await client.query(`DELETE FROM videos WHERE channel_id = $1`, [channel.id]);

  for (let i = 0; i < rawVideos.length; i++) {
    const video = rawVideos[i];
    await client.query(
      `INSERT INTO videos (video_id, channel_id, position, raw_data, published_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [
        video.id,
        channel.id,
        i,
        JSON.stringify(video),
        video.snippet?.publishedAt || null,
      ]
    );
  }

  return now;
}

export async function logQuotaUsage(client, { calls, channelId, requestSource }) {
  for (const call of calls) {
    await client.query(
      `INSERT INTO quota_logs (endpoint, units, channel_id, request_source)
       VALUES ($1, $2, $3, $4)`,
      [call.endpoint, call.units, channelId || null, requestSource || null]
    );
  }
}

export function toAnalyzeResponse(row, rawVideos, source, unitsUsed) {
  return {
    source,
    units_used: unitsUsed,
    channelId: row.channel_id,
    lastSyncedAt: row.last_synced_at,
    channel: row.channel_data,
    videoIds: row.video_ids,
    rawVideos,
  };
}

export async function getCachedChannelBundle(client, row) {
  const rawVideos = await loadChannelVideos(client, row.channel_id);
  return toAnalyzeResponse(row, rawVideos, "cache", 0);
}

export async function saveAndReturnBundle(client, payload, tracker, requestSource) {
  const lastSyncedAt = await upsertChannelCache(client, payload);
  await logQuotaUsage(client, {
    calls: tracker.calls,
    channelId: payload.channel.id,
    requestSource,
  });

  const row = {
    channel_id: payload.channel.id,
    channel_data: payload.channel,
    video_ids: payload.videoIds,
    last_synced_at: lastSyncedAt,
  };

  return toAnalyzeResponse(row, payload.rawVideos, "api", tracker.units);
}

export async function analyzeChannel({ handle, apiKey }) {
  const attempts = parseChannelAttempts(handle);
  if (!attempts) {
    const err = new Error("handle is required");
    err.status = 400;
    throw err;
  }

  const lookupKey = lookupHandleKey(handle);

  return withTransaction(async (client) => {
    const existing = await findChannelByLookupKey(client, lookupKey);

    if (existing && isCacheFresh(existing.last_synced_at)) {
      return getCachedChannelBundle(client, existing);
    }

    const tracker = new QuotaTracker();
    const fetched = await fetchChannelFromYouTube(apiKey, attempts, tracker);

    return saveAndReturnBundle(
      client,
      {
        channel: fetched.channel,
        videoIds: fetched.videoIds,
        rawVideos: fetched.rawVideos,
        handleKey: lookupKey,
      },
      tracker,
      existing ? "refresh" : "initial"
    );
  });
}
