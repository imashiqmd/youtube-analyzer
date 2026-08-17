import { pool, withTransaction } from "./db.js";
import { parseChannelAttempts, lookupHandleKey, isCacheFresh } from "./handle.js";
import { fetchChannelFromYouTube, QuotaTracker } from "./youtube.js";
import { logUserActivity } from "./userService.js";

const CHANNEL_SELECT = `
  channel_id,
  handle,
  uploads_playlist_id,
  channel_data,
  video_ids,
  cached_videos,
  last_synced_at
`;

function rawVideosFromRow(row) {
  if (Array.isArray(row.cached_videos) && row.cached_videos.length) {
    return row.cached_videos;
  }
  if (Array.isArray(row.raw_videos)) {
    return row.raw_videos;
  }
  if (typeof row.raw_videos === "string") {
    return JSON.parse(row.raw_videos);
  }
  return [];
}

function rowToBundle(row, source, unitsUsed = 0) {
  return toAnalyzeResponse(row, rawVideosFromRow(row), source, unitsUsed);
}

export async function findChannelBundleByLookupKey(client, lookupKey) {
  if (!lookupKey) return null;

  const { rows } = await client.query(
    `SELECT ${CHANNEL_SELECT}
     FROM channels
     WHERE LOWER(handle) = LOWER($1)
     LIMIT 1`,
    [lookupKey]
  );
  if (rows[0] && rawVideosFromRow(rows[0]).length) return rows[0];

  if (/^UC[\w-]{20,}$/.test(lookupKey)) {
    const byId = await client.query(
      `SELECT ${CHANNEL_SELECT}
       FROM channels
       WHERE channel_id = $1
       LIMIT 1`,
      [lookupKey]
    );
    if (byId.rows[0]) return byId.rows[0];
  }

  if (rows[0]) return rows[0];

  return null;
}

export async function resolveCachedChannelId(handle) {
  const lookupKey = lookupHandleKey(handle);
  if (!lookupKey) return null;
  const row = await findChannelBundleByLookupKey(pool, lookupKey);
  return row ? row.channel_id : null;
}

async function loadVideosFromTable(client, channelId) {
  const { rows } = await client.query(
    `SELECT COALESCE(
       json_agg(raw_data ORDER BY position)
         FILTER (WHERE video_id IS NOT NULL),
       '[]'::json
     ) AS raw_videos
     FROM videos
     WHERE channel_id = $1`,
    [channelId]
  );
  return rows[0]?.raw_videos || [];
}

export async function getChannelBundleById(channelId) {
  if (!channelId) return null;

  const { rows } = await pool.query(
    `SELECT ${CHANNEL_SELECT}
     FROM channels
     WHERE channel_id = $1
     LIMIT 1`,
    [channelId]
  );
  if (!rows[0]) return null;

  const row = rows[0];
  if (!rawVideosFromRow(row).length) {
    const rawVideos = await loadVideosFromTable(pool, channelId);
    if (rawVideos.length) {
      row.cached_videos = rawVideos;
      pool.query(
        `UPDATE channels SET cached_videos = $2::jsonb, updated_at = NOW() WHERE channel_id = $1`,
        [channelId, JSON.stringify(rawVideos)]
      ).catch(() => {});
    }
  }

  return rowToBundle(row, "cache", 0);
}

export async function upsertChannelCache(client, {
  channel,
  videoIds,
  rawVideos,
  handleKey,
}) {
  const now = new Date().toISOString();
  const compactVideos = rawVideos || [];

  await client.query(
    `INSERT INTO channels (
       channel_id, handle, uploads_playlist_id, channel_data, video_ids, cached_videos, last_synced_at, updated_at
     ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $7)
     ON CONFLICT (channel_id) DO UPDATE SET
       handle = EXCLUDED.handle,
       uploads_playlist_id = EXCLUDED.uploads_playlist_id,
       channel_data = EXCLUDED.channel_data,
       video_ids = EXCLUDED.video_ids,
       cached_videos = EXCLUDED.cached_videos,
       last_synced_at = EXCLUDED.last_synced_at,
       updated_at = EXCLUDED.updated_at`,
    [
      channel.id,
      handleKey,
      channel.uploadsPlaylistId,
      JSON.stringify(channel),
      JSON.stringify(videoIds),
      JSON.stringify(compactVideos),
      now,
    ]
  );

  await client.query(`DELETE FROM videos WHERE channel_id = $1`, [channel.id]);

  if (compactVideos.length) {
    const videoIdsArr = [];
    const positions = [];
    const rawDatas = [];
    const publishedAts = [];

    for (let i = 0; i < compactVideos.length; i++) {
      const video = compactVideos[i];
      videoIdsArr.push(video.id);
      positions.push(i);
      rawDatas.push(JSON.stringify(video));
      publishedAts.push(video.snippet?.publishedAt || null);
    }

    await client.query(
      `INSERT INTO videos (video_id, channel_id, position, raw_data, published_at)
       SELECT vid, $1, pos, raw::jsonb, pub
       FROM unnest($2::text[], $3::int[], $4::text[], $5::timestamptz[])
         AS u(vid, pos, raw, pub)`,
      [channel.id, videoIdsArr, positions, rawDatas, publishedAts]
    );
  }

  return now;
}

export async function logQuotaUsage(client, { calls, channelId, requestSource, userId = null }) {
  if (!calls.length) return;

  const endpoints = [];
  const units = [];
  const channelIds = [];
  const sources = [];
  const userIds = [];

  for (const call of calls) {
    endpoints.push(call.endpoint);
    units.push(call.units);
    channelIds.push(channelId || null);
    sources.push(requestSource || null);
    userIds.push(userId || null);
  }

  await client.query(
    `INSERT INTO quota_logs (endpoint, units, channel_id, request_source, user_id)
     SELECT e, u, c, s, uid
     FROM unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::uuid[])
       AS t(e, u, c, s, uid)`,
    [endpoints, units, channelIds, sources, userIds]
  );
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

export async function saveAndReturnBundle(client, payload, tracker, requestSource, userId = null) {
  const lastSyncedAt = await upsertChannelCache(client, payload);
  await logQuotaUsage(client, {
    calls: tracker.calls,
    channelId: payload.channel.id,
    requestSource,
    userId,
  });

  const row = {
    channel_id: payload.channel.id,
    channel_data: payload.channel,
    video_ids: payload.videoIds,
    last_synced_at: lastSyncedAt,
  };

  return toAnalyzeResponse(row, payload.rawVideos, "api", tracker.units);
}

export async function analyzeChannel({ handle, apiKey, userId = null }) {
  const attempts = parseChannelAttempts(handle);
  if (!attempts) {
    const err = new Error("handle is required");
    err.status = 400;
    throw err;
  }

  const lookupKey = lookupHandleKey(handle);

  let cachedRow = await findChannelBundleByLookupKey(pool, lookupKey);

  if (cachedRow && !rawVideosFromRow(cachedRow).length) {
    const rawVideos = await loadVideosFromTable(pool, cachedRow.channel_id);
    if (rawVideos.length) {
      cachedRow.cached_videos = rawVideos;
      pool.query(
        `UPDATE channels SET cached_videos = $2::jsonb, updated_at = NOW() WHERE channel_id = $1`,
        [cachedRow.channel_id, JSON.stringify(rawVideos)]
      ).catch(() => {});
    }
  }

  if (cachedRow && isCacheFresh(cachedRow.last_synced_at) && rawVideosFromRow(cachedRow).length) {
    const result = rowToBundle(cachedRow, "cache", 0);
    if (userId) {
      logUserActivity(userId, "analyze_channel", {
        channelId: result.channelId,
        metadata: {
          handle: handle.trim(),
          source: result.source,
          units_used: result.units_used,
        },
      }).catch(() => {});
    }
    return result;
  }

  const tracker = new QuotaTracker();
  const fetched = await fetchChannelFromYouTube(apiKey, attempts, tracker);

  const result = await withTransaction(async (client) => {
    return saveAndReturnBundle(
      client,
      {
        channel: fetched.channel,
        videoIds: fetched.videoIds,
        rawVideos: fetched.rawVideos,
        handleKey: lookupKey,
      },
      tracker,
      cachedRow ? "refresh" : "initial",
      userId
    );
  });

  if (userId) {
    logUserActivity(userId, "analyze_channel", {
      channelId: result.channelId,
      metadata: {
        handle: handle.trim(),
        source: result.source,
        units_used: result.units_used,
      },
    }).catch(() => {});
  }

  return result;
}
